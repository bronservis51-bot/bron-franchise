#!/usr/bin/env python3
"""Native Deno/pg synthetic TLS + PostgreSQL wire proof; loopback only, no Source."""
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading


def main():
    deno = os.environ.get('DENO_BIN') or shutil.which('deno')
    if not deno:
        raise RuntimeError('Set DENO_BIN to a native Deno executable')
    stats = {'connections': 0, 'startup': 0, 'query': 0, 'tls_rejected': 0}
    with tempfile.TemporaryDirectory(prefix='bron-source-https-probe-native-') as temporary:
        work = Path(temporary)

        def openssl(*arguments):
            subprocess.run(['openssl', *arguments], cwd=work, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

        for name in ['ca', 'wrong']:
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=synthetic-' + name,
                    '-addext', 'basicConstraints=critical,CA:TRUE',
                    '-keyout', name + '.key', '-out', name + '.crt')
        openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=bron-probe.invalid',
                '-keyout', 'server.key', '-out', 'server.csr')
        (work / 'ext.cnf').write_text('subjectAltName=DNS:bron-probe.invalid\n'
                                    'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
        openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
                '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'server.crt')
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(work / 'server.crt', work / 'server.key')
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.settimeout(0.2)
        port = listener.getsockname()[1]
        stop, threads, errors = threading.Event(), [], []

        def exact(connection, size):
            result = b''
            while len(result) < size:
                part = connection.recv(size - len(result))
                if not part:
                    raise EOFError()
                result += part
            return result

        def message(kind, payload):
            return kind + struct.pack('!I', len(payload) + 4) + payload

        def handle(connection):
            try:
                connection.settimeout(10)
                assert exact(connection, 8) == struct.pack('!II', 8, 80877103)
                connection.sendall(b'S')
                try:
                    connection = context.wrap_socket(connection, server_side=True)
                except ssl.SSLError:
                    stats['tls_rejected'] += 1
                    return
                size = struct.unpack('!I', exact(connection, 4))[0]
                exact(connection, size - 4)
                stats['startup'] += 1
                connection.sendall(message(b'R', struct.pack('!I', 0)) +
                    message(b'S', b'server_version\x0017.0\x00') +
                    message(b'S', b'client_encoding\x00UTF8\x00') + message(b'Z', b'I'))
                while True:
                    kind = exact(connection, 1)
                    size = struct.unpack('!I', exact(connection, 4))[0]
                    payload = exact(connection, size - 4)
                    if kind == b'X':
                        break
                    assert kind == b'Q'
                    assert payload == b"SELECT repeat('x',524288) AS payload\x00"
                    stats['query'] += 1
                    field = b'payload\x00' + struct.pack('!IhIhih', 0, 0, 25, -1, -1, 0)
                    connection.sendall(message(b'T', struct.pack('!h', 1) + field) +
                        message(b'D', struct.pack('!hi', 1, 524288) + b'x' * 524288) +
                        message(b'C', b'SELECT 1\x00') + message(b'Z', b'I'))
            except (EOFError, ConnectionError):
                pass
            except Exception as error:
                errors.append(type(error).__name__)
            finally:
                connection.close()

        def accept():
            while not stop.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                stats['connections'] += 1
                thread = threading.Thread(target=handle, args=(connection,), daemon=True)
                threads.append(thread)
                thread.start()

        accept_thread = threading.Thread(target=accept)
        accept_thread.start()
        try:
            environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                           'PROBE_TLS_PORT': str(port), 'PROBE_TLS_DIR': temporary}
            if os.environ.get('DENO_DIR'):
                environment['DENO_DIR'] = os.environ['DENO_DIR']
            child = subprocess.run([deno, 'run', '--cached-only', '--allow-net=127.0.0.1',
                '--allow-read=' + temporary, '--allow-env',
                str(Path(__file__).with_suffix('.ts'))], env=environment,
                text=True, capture_output=True, timeout=40)
            assert child.returncode == 0, child.stderr
            summary = json.loads(child.stdout)
        finally:
            stop.set()
            listener.close()
            accept_thread.join(timeout=1)
            for thread in threads:
                thread.join(timeout=1)
        assert not errors, errors
        assert stats == {'connections': 3, 'startup': 1, 'query': 1, 'tls_rejected': 2}, stats
    summary.update({'syntheticWireServer': stats, 'sourceVpsContact': False,
                    'realData': False, 'temporarySyntheticKeysRemoved': not work.exists()})
    print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    main()
