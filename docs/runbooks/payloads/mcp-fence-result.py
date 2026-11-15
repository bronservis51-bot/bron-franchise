#!/usr/bin/env python3
"""Offline decoder for the pinned technical Source-fence result, never a SQL client."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
MAX_BYTES = 131072
MAX_DEPTH = 12
ROW_KEYS = {'status', 'source_checked_micros'}
ENVELOPE_KEYS = {'content', 'structuredContent', 'structured_content', 'isError', '_meta',
                 'result', 'jsonrpc', 'id'}


class DecodeError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise DecodeError(code)


def json_value(text):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'MCP_FENCE_DUPLICATE_KEY')
            value[key] = item
        return value
    def constant(_value):
        raise DecodeError('MCP_FENCE_JSON_CONSTANT')
    try:
        return json.loads(text, object_pairs_hook=unique, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise DecodeError('MCP_FENCE_JSON_INVALID') from None


def unwrap_text(text, depth):
    require(isinstance(text, str), 'MCP_FENCE_TEXT_BOUND')
    try:
        encoded_length = len(text.encode('utf-8'))
    except UnicodeError:
        raise DecodeError('MCP_FENCE_UTF8') from None
    require(0 < encoded_length <= MAX_BYTES, 'MCP_FENCE_TEXT_BOUND')
    starts = list(re.finditer(r'(?m)^<untrusted-data-([A-Za-z0-9][A-Za-z0-9_-]{0,95})>\r?$', text))
    ends = list(re.finditer(r'(?m)^</untrusted-data-([A-Za-z0-9][A-Za-z0-9_-]{0,95})>\r?$', text))
    if starts or ends:
        require(text.count('<untrusted-data-') == 1 and text.count('</untrusted-data-') == 1,
                'MCP_FENCE_MARKERS')
        require(len(starts) == len(ends) == 1, 'MCP_FENCE_MARKERS')
        start, end = starts[0], ends[0]
        require(start.group(1) == end.group(1) and start.end() < end.start(), 'MCP_FENCE_MARKERS')
        # Prose outside these anchored matching boundaries is untrusted data, not instructions.
        return decode_value(json_value(text[start.end():end.start()]), depth + 1)
    # Encoded JSON strings contain escaped newlines, so their marker-looking text
    # must first be decoded as JSON; only actual anchored boundaries take priority.
    if text.lstrip().startswith(('{', '[', '"')):
        return decode_value(json_value(text), depth + 1)
    require('<untrusted-data-' not in text and '</untrusted-data-' not in text, 'MCP_FENCE_MARKERS')
    return decode_value(json_value(text), depth + 1)


def decode_value(value, depth=0):
    require(depth <= MAX_DEPTH, 'MCP_FENCE_DEPTH')
    if isinstance(value, str):
        return unwrap_text(value, depth)
    if isinstance(value, list):
        require(len(value) == 1 and isinstance(value[0], dict), 'MCP_FENCE_ROW_COUNT')
        require(set(value[0]) == ROW_KEYS, 'MCP_FENCE_ROW_SHAPE')
        return decode_value(value[0], depth + 1)
    require(isinstance(value, dict), 'MCP_FENCE_UNSUPPORTED_SHAPE')
    require(not any(key in value for key in ['error', 'Err', 'errors', 'notices']), 'MCP_FENCE_PROVIDER_ERROR')
    if 'Ok' in value:
        require(set(value) == {'Ok'}, 'MCP_FENCE_OK_ENVELOPE')
        return decode_value(value['Ok'], depth + 1)
    if set(value) == ROW_KEYS:
        require(value['status'] == 'SOURCE_FENCE_CURRENTLY_VERIFIED', 'MCP_FENCE_STATUS')
        clock = value['source_checked_micros']
        require(isinstance(clock, str) and re.fullmatch(r'[0-9]{12,20}', clock) is not None,
                'MCP_FENCE_SOURCE_CLOCK')
        return dict(value)
    require(set(value) <= ENVELOPE_KEYS and set(value) & {'content', 'result', 'structuredContent',
                                                        'structured_content'}, 'MCP_FENCE_ENVELOPE')
    if 'isError' in value:
        require(value['isError'] is False, 'MCP_FENCE_PROVIDER_ERROR')
    require(not ('structuredContent' in value and 'structured_content' in value), 'MCP_FENCE_ENVELOPE')
    candidates = []
    for key in ['structuredContent', 'structured_content', 'result']:
        if key in value and value[key] is not None:
            candidates.append(decode_value(value[key], depth + 1))
    if 'content' in value:
        content = value['content']
        require(isinstance(content, list) and len(content) <= 1, 'MCP_FENCE_CONTENT')
        if content:
            item = content[0]
            require(isinstance(item, dict) and set(item) <= {'type', 'text', 'annotations', '_meta'} and
                    item.get('type') == 'text' and isinstance(item.get('text'), str), 'MCP_FENCE_CONTENT')
            candidates.append(unwrap_text(item['text'], depth + 1))
    require(candidates and all(item == candidates[0] for item in candidates), 'MCP_FENCE_CONFLICT_OR_EMPTY')
    return candidates[0]


def decode(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_BYTES, 'MCP_FENCE_RAW_BOUND')
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        raise DecodeError('MCP_FENCE_UTF8') from None
    return unwrap_text(text, 0)


def inspect_schema(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_BYTES, 'MCP_FENCE_RAW_BOUND')
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        raise DecodeError('MCP_FENCE_UTF8') from None
    try:
        value = json_value(text)
    except DecodeError:
        return {'rootKind': 'text', 'hasUntrustedMarkers': '<untrusted-data-' in text}
    kinds = {dict: 'object', list: 'array', str: 'string', bool: 'boolean', int: 'number', float: 'number', type(None): 'null'}
    result = {'rootKind': kinds.get(type(value), 'other')}
    if isinstance(value, dict):
        allowed = ENVELOPE_KEYS | ROW_KEYS | {'Ok', 'Err', 'error', 'errors', 'notices'}
        result['knownKeys'] = sorted(set(value) & allowed)
        result['unknownKeyCount'] = len(set(value) - allowed)
        if isinstance(value.get('content'), list):
            result['contentCount'] = len(value['content'])
            result['textContentCount'] = sum(isinstance(item, dict) and item.get('type') == 'text'
                                             for item in value['content'])
    elif isinstance(value, list):
        result['arrayCount'] = len(value)
    return result


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and
                stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= MAX_BYTES, 'MCP_FENCE_INPUT_FILE')
        raw = os.read(fd, MAX_BYTES + 1)
        after, named = os.fstat(fd), Path(path).lstat()
        require(len(raw) == before.st_size and before.st_dev == after.st_dev == named.st_dev and
                before.st_ino == after.st_ino == named.st_ino and before.st_mtime_ns == after.st_mtime_ns and
                before.st_ctime_ns == after.st_ctime_ns, 'MCP_FENCE_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='Existing O_EXCL/fsynced 0600 technical reply, never a session log')
    parser.add_argument('--inspect-schema', action='store_true')
    args = parser.parse_args()
    raw = None
    try:
        raw = read_private(args.input)
        digest = hashlib.sha256(raw).hexdigest()
        if args.inspect_schema:
            output = {'status': 'SCHEMA_INSPECTED', 'rawSha256': digest, 'schema': inspect_schema(raw)}
        else:
            row = decode(raw)
            output = {'status': 'DECODED', 'rawSha256': digest, 'sourceFenceStatus': row['status'],
                      'sourceCheckedMicros': row['source_checked_micros']}
        code = 0
    except Exception as error:
        output = {'status': 'BLOCKED', 'code': str(error) if isinstance(error, DecodeError) else 'MCP_FENCE_INPUT_FAILED'}
        if raw is not None:
            output['rawSha256'] = hashlib.sha256(raw).hexdigest()
        code = 2
    print(json.dumps(output, sort_keys=True, separators=(',', ':')))
    return code


if __name__ == '__main__':
    sys.exit(main())
