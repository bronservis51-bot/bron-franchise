#!/usr/bin/env python3
"""Encrypt a separate read-only metadata snapshot on the established Russian VPS.

Never modifies the original SQL/Auth backup or source. This is a newer snapshot,
not a replacement for final reconciliation or Auth/SMTP/Edge secret export.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import sys
import tempfile
import types
import uuid

CHECKOUT = Path("/opt/bron/migration")
DRIVER_FILE = CHECKOUT / "deploy/timeweb/source-backup.py"
DRIVER_SHA256 = "94c4a9411db6085ac18daae0fd18e7a5f14f2c9a82adb256e39f73039121f75d"
OWNER_UID = 0
SOURCE_PROJECT = "vkkqffvmztpzgygzfxhq"
EXPECTED_FILES = frozenset(name + ".zst.age" for name in (
    "roles.sql", "schema.sql", "data.sql", "raw-schema-archive.sql",
    "vault-ciphertext.sql", "managed-migration-versions.sql", "vault-logical.csv"))
NOT_CAPTURED = ["auth_provider_jwt_smtp_runtime_configuration",
               "edge_environment_secret_values_and_live_deployments",
               "storage_object_bytes", "independent_storage_and_key_custody",
               "isolated_restore_and_final_write_freeze_reconciliation"]


class SupplementError(RuntimeError):
    """Only fixed codes are printed."""


def load_driver():
    # Hash the bytes that will be executed, not a path reopened by an importer.
    for path in (CHECKOUT, CHECKOUT / "deploy", CHECKOUT / "deploy/timeweb"):
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != OWNER_UID
                or info.st_mode & 0o022):
            raise SupplementError("UNSAFE_PINNED_DRIVER_DIRECTORY")
    fd = os.open(DRIVER_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID
                or info.st_mode & 0o022):
            raise SupplementError("UNSAFE_PINNED_DRIVER_FILE")
        content = stream.read(2 * 1024 * 1024 + 1)
    if hashlib.sha256(content).hexdigest() != DRIVER_SHA256:
        raise SupplementError("PINNED_DRIVER_SHA256_MISMATCH")
    module = types.ModuleType("bron_verified_source_backup")
    module.__file__ = str(DRIVER_FILE)
    exec(compile(content, str(DRIVER_FILE), "exec"), module.__dict__)
    return module


@contextlib.contextmanager
def private_input(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise SupplementError("UNSAFE_ORIGINAL_MANIFEST")
        yield stream


def original_manifest(path, driver):
    if (not path.is_absolute() or path.name != "manifest.json"
            or path.parent.parent != driver.BACKUP_ROOT
            or not re.fullmatch(r"source-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", path.parent.name)):
        raise SupplementError("EXPLICIT_SOURCE_MANIFEST_REQUIRED")
    driver.secure_path(path.parent, directory=True)
    with private_input(path) as stream:
        content = stream.read(131073)
    if len(content) > 131072:
        raise SupplementError("ORIGINAL_MANIFEST_TOO_LARGE")
    try:
        manifest = json.loads(content)
    except (ValueError, UnicodeError):
        raise SupplementError("ORIGINAL_MANIFEST_INVALID") from None
    if (not isinstance(manifest, dict) or type(manifest.get("format")) is not int
            or manifest["format"] != 1 or manifest.get("complete") is not False
            or manifest.get("status") != "sql_auth_stage_only_restore_unverified"
            or manifest.get("source_project") != SOURCE_PROJECT):
        raise SupplementError("ORIGINAL_SQL_AUTH_MANIFEST_REQUIRED")
    artifacts = manifest.get("artifacts")
    if (not isinstance(artifacts, list) or len(artifacts) != 7
            or any(not isinstance(item, dict) or not isinstance(item.get("file"), str)
                   for item in artifacts)
            or {item["file"] for item in artifacts} != EXPECTED_FILES):
        raise SupplementError("ORIGINAL_SEVEN_ARTIFACT_REFERENCES_REQUIRED")
    snapshot = manifest.get("snapshot_metadata", {}).get("snapshot")
    if not isinstance(snapshot, str) or not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot):
        raise SupplementError("ORIGINAL_SNAPSHOT_REFERENCE_REQUIRED")
    return manifest, hashlib.sha256(content).hexdigest()


# All values, including potentially sensitive settings/commands/object names,
# leave psql only into the zstd -> age pipe. No SQL is executed from these values.
QUERIES = {
    "schemas": """select nspname,pg_get_userbyid(nspowner) as owner,nspacl
      from pg_namespace where nspname in ('auth','storage')""",
    "relations": """select n.nspname,c.relname,c.relkind,c.relpersistence,
      pg_get_userbyid(c.relowner) as owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl,
      case when c.relkind='v' then pg_get_viewdef(c.oid,true) end as view_definition
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('auth','storage') and c.relkind in ('r','p','v','S')""",
    "columns": """select n.nspname,c.relname,a.attname,a.attnum,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attidentity,
      a.attgenerated,a.attacl,pg_get_expr(d.adbin,d.adrelid) as default_value,
      case when a.attcollation=0 then null else a.attcollation::regcollation::text end as collation
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname in ('auth','storage') and c.relkind in ('r','p','v')
        and a.attnum>0 and not a.attisdropped""",
    "constraints": """select n.nspname,c.relname,k.conname,k.contype,k.convalidated,
      pg_get_constraintdef(k.oid,true) as definition
      from pg_constraint k join pg_class c on c.oid=k.conrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage')""",
    "indexes": """select schemaname,tablename,indexname,indexdef from pg_indexes
      where schemaname in ('auth','storage')""",
    "policies": """select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname in ('auth','storage')""",
    "triggers": """select n.nspname,c.relname,t.tgname,t.tgenabled,
      pg_get_triggerdef(t.oid,true) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('auth','storage') and not t.tgisinternal""",
    "routines": """select n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid) as args,pg_get_functiondef(p.oid) as definition,
      pg_get_userbyid(p.proowner) as owner,p.proacl,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('auth','storage') and p.prokind in ('f','p')""",
    "enums": """select n.nspname,t.typname,e.enumsortorder,e.enumlabel from pg_enum e
      join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
      where n.nspname in ('auth','storage')""",
    "default_grants": """select pg_get_userbyid(d.defaclrole) as owner,n.nspname,
      d.defaclobjtype,d.defaclacl from pg_default_acl d
      left join pg_namespace n on n.oid=d.defaclnamespace
      where n.nspname in ('auth','storage') or d.defaclnamespace=0""",
    "roles_without_passwords": """select rolname,rolsuper,rolinherit,rolcreaterole,
      rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig
      from pg_roles""",
    "role_memberships": """select pg_get_userbyid(roleid) as role,
      pg_get_userbyid(member) as member,admin_option,inherit_option,set_option from pg_auth_members""",
    "database_role_settings": """select d.datname,r.rolname,s.setconfig from pg_db_role_setting s
      left join pg_database d on d.oid=s.setdatabase left join pg_roles r on r.oid=s.setrole
      where s.setdatabase in (0,(select oid from pg_database where datname=current_database()))""",
    "extensions": """select e.extname,e.extversion,n.nspname as schema from pg_extension e
      join pg_namespace n on n.oid=e.extnamespace""",
    "managed_auth_migrations": "select * from auth.schema_migrations",
    "managed_storage_migrations": "select * from storage.migrations",
    "storage_buckets": "select * from storage.buckets",
    "storage_objects": "select * from storage.objects",
    "cron_jobs": "select * from cron.job",
    "pg_net_queue_state": """select count(*) as count,
      encode(sha256(convert_to(coalesce(string_agg(to_jsonb(q)::text,E'\\n'
      order by to_jsonb(q)::text collate \"C\"),''),'UTF8')),'hex') as sha256
      from net.http_request_queue q""",
    "scheduler_runtime_settings": """select name,setting,source,pending_restart from pg_settings
      where name in ('cron.launch_active_jobs','pg_net.batch_size','pg_net.database_name')""",
}


def metadata_sql(snapshot):
    if not isinstance(snapshot, str) or not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot):
        raise SupplementError("INVALID_NEW_SNAPSHOT")
    pairs = []
    for name, query in QUERIES.items():
        pairs.append("'" + name + "',coalesce((select json_agg(to_jsonb(q) "
                     "order by to_jsonb(q)::text collate \"C\") from (" + query + ") q),'[]'::json)")
    return ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
            f"SET TRANSACTION SNAPSHOT '{snapshot}';\n"
            "SET LOCAL TIME ZONE 'UTC';\n"
            "SELECT json_build_object('format',1,'source_project','" + SOURCE_PROJECT + "',"
            "'capture_kind','independent_new_read_only_snapshot',"
            "'read_only',current_setting('transaction_read_only'),"
            "'snapshot_id','" + snapshot + "','catalog',json_build_object(" + ",".join(pairs) + "));\n"
            "ROLLBACK;\n")


def capture(manifest_path):
    if os.geteuid() != 0 or sys.platform != "linux":
        raise SupplementError("VERIFIED_VPS_ROOT_REQUIRED")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    driver = load_driver()
    driver.preflight(True)  # Existing canonical TLS/service/pgpass and verified VPS.
    original, original_sha256 = original_manifest(manifest_path, driver)
    driver.secure_path(driver.IDENTITY_FILE)  # Do not generate a different backup key.
    lockfd = os.open(driver.BACKUP_ROOT / ".source-backup.lock",
                     os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, "w") as lock:
        driver.secure_path(driver.BACKUP_ROOT / ".source-backup.lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SupplementError("SOURCE_BACKUP_ALREADY_RUNNING") from None
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        directory = driver.BACKUP_ROOT / f"supplement-{stamp}-{uuid.uuid4().hex[:8]}"
        directory.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".metadata-", dir=directory) as temporary:
            # -y reads an existing identity and cannot create a replacement key.
            recipient = driver.capture(["/usr/bin/age-keygen", "-y", str(driver.IDENTITY_FILE)],
                                       driver.clean_env(Path(temporary))).strip()
            if not re.fullmatch(r"age1[0-9a-z]{40,100}", recipient):
                raise SupplementError("INVALID_EXISTING_ENCRYPTION_RECIPIENT")
            if recipient != original.get("encryption_recipient"):
                raise SupplementError("ORIGINAL_ENCRYPTION_RECIPIENT_MISMATCH")
            env = driver.source_env(Path(temporary), True)
            keeper = driver.Snapshot(env)
            try:
                snapshot = keeper.start()["snapshot"]
                command = ["/usr/bin/psql", "-X", "-q", "-A", "-t", "-w", "-v",
                           "ON_ERROR_STOP=1", "--dbname", "service=bron_source",
                           "--command", metadata_sql(snapshot)]
                artifact = driver.encrypted_artifact(directory, "managed-metadata.json", command,
                                                     env, recipient, keeper)
                keeper.finish()
            finally:
                keeper.stop()
            # If another administrator changed the original, do not attest to it.
            with private_input(manifest_path) as stream:
                if hashlib.sha256(stream.read(131073)).hexdigest() != original_sha256:
                    raise SupplementError("ORIGINAL_MANIFEST_CHANGED")
            manifest = {"format": 1, "complete": False,
                        "status": "metadata_supplement_only_restore_unverified",
                        "created_utc": stamp, "source_project": SOURCE_PROJECT,
                        "original_manifest": str(manifest_path),
                        "original_manifest_sha256": original_sha256,
                        "original_snapshot": original["snapshot_metadata"]["snapshot"],
                        "new_snapshot": snapshot, "same_snapshot_as_sql": False,
                        "pinned_driver_sha256": DRIVER_SHA256,
                        "encryption_recipient": recipient, "artifacts": [artifact],
                        "not_captured": NOT_CAPTURED,
                        "warnings": ["newer_metadata_does_not_complete_the_original_sql_snapshot",
                                     "catalog_records_are_evidence_not_sql_to_apply_blindly"]}
            driver.private_file(directory / "manifest.json.part",
                                (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
            os.rename(directory / "manifest.json.part", directory / "manifest.json")
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    return {"status": "METADATA_SUPPLEMENT_SAVED", "complete": False,
            "same_snapshot_as_sql": False, "source_modified": False,
            "original_manifest_modified": False, "restore_performed": False}


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise SupplementError("USE_EXPLICIT_MANIFEST_ARGUMENT")
    parser = Parser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(capture(args.manifest), sort_keys=True))


def interrupted(_signum, _frame):
    # Raising unwinds encrypted_artifact/Snapshot cleanup on a closed terminal.
    raise SupplementError("INTERRUPTED")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({"status": "CANCELLED", "complete": False}))
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, SupplementError) else "METADATA_SUPPLEMENT_FAILED"
        print(json.dumps({"status": code, "complete": False}))
        sys.exit(1)
