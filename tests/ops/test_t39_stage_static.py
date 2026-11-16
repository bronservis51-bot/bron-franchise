"""Synthetic T39 static-staging checks; no CLI, network, VPS or real data."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "docs/runbooks/payloads/t39-stage-static.py"
SPEC = importlib.util.spec_from_file_location("bron_t39_stage_static", SCRIPT)
staging = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = staging
SPEC.loader.exec_module(staging)


def digest(content):
    return hashlib.sha256(content).hexdigest()


class StaticPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.source = self.root / "source"
        self.source.mkdir(mode=0o700)
        self.owner_uid = os.getuid()
        self.contents = {
            "index.html": b"<!doctype html><title>public fixture</title>\n",
            "assets/app.js": b"console.log('synthetic public bundle');\n",
        }
        for relative, content in self.contents.items():
            self.write_private(self.source / relative, content)
        self.manifest = {
            "format": 1,
            "sourceCommit": "a" * 40,
            "base": "/",
            "apiOrigin": "https://api.example.invalid",
            "files": [self.entry(relative, content)
                      for relative, content in sorted(self.contents.items())],
        }
        self.save_manifest()
        self.destination_number = 0

    def write_private(self, path, content):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(0o600)

    def entry(self, relative, content):
        return {"file": relative, "bytes": len(content), "sha256": digest(content)}

    def save_manifest(self):
        content = (json.dumps(self.manifest, sort_keys=True, indent=2) + "\n").encode()
        self.write_private(self.source / "release-manifest.json", content)
        self.pin = {
            "manifestSha256": digest(content),
            "sourceCommit": self.manifest["sourceCommit"],
            "base": self.manifest["base"],
            "fileCount": len(self.manifest["files"]),
        }

    def scan(self, **kwargs):
        return staging.scan_package(self.source, self.pin,
                                    owner_uid=kwargs.get("owner_uid", self.owner_uid))

    def destination(self):
        self.destination_number += 1
        return self.root / ("destination-" + str(self.destination_number))

    def stage(self, package=None):
        destination = self.destination()
        staging.stage_package(destination, package or self.scan(), owner_uid=self.owner_uid)
        return destination

    def assert_destination_rejected(self, destination, package):
        with self.assertRaises(staging.StagingError):
            staging.validate_destination(destination, package, owner_uid=self.owner_uid)

    def test_scan_checks_pinned_manifest_and_returns_exact_public_bytes(self):
        package = self.scan()
        expected = dict(self.contents)
        expected["release-manifest.json"] = (self.source / "release-manifest.json").read_bytes()
        self.assertEqual(package["files"], expected)
        self.assertEqual(package["manifestSha256"], self.pin["manifestSha256"])
        self.assertTrue(all(isinstance(content, bytes) for content in package["files"].values()))

    def test_public_source_0644_files_and_manifest_are_accepted(self):
        for relative in (*self.contents, "release-manifest.json"):
            (self.source / relative).chmod(0o644)
        self.assertEqual(self.scan()["contentFiles"], len(self.contents))

    def test_extra_empty_destination_directory_is_not_exact_reuse(self):
        package = self.scan()
        destination = self.stage(package)
        (destination / "unexpected-empty").mkdir(mode=0o755)
        with self.assertRaises(staging.StagingError):
            staging.validate_destination(destination, package, owner_uid=self.owner_uid)

    def test_missing_destination_is_classified_without_creating_it(self):
        destination = self.destination()
        self.assertEqual(staging.validate_destination(destination, self.scan(),
                                                      owner_uid=self.owner_uid), "MISSING")
        self.assertFalse(destination.exists())

    def test_stage_copies_bytes_with_public_modes_even_under_private_umask(self):
        package = self.scan()
        destination = self.destination()
        previous_umask = os.umask(0o077)
        try:
            created = staging.stage_package(destination, package, owner_uid=self.owner_uid)
        finally:
            os.umask(previous_umask)
        self.assertIsInstance(created, list)
        self.assertTrue(created)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((destination / "assets").stat().st_mode), 0o755)
        for relative, content in package["files"].items():
            path = destination / relative
            self.assertEqual(path.read_bytes(), content)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(path.stat().st_nlink, 1)
        # The extracted package remains private and unchanged.
        self.assertEqual(stat.S_IMODE(self.source.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.source / "index.html").stat().st_mode), 0o600)

    def test_exact_existing_tree_is_reused_without_rewriting_any_file(self):
        package = self.scan()
        destination = self.stage(package)
        before = {relative: ((destination / relative).stat().st_ino,
                             (destination / relative).stat().st_mtime_ns,
                             (destination / relative).read_bytes())
                  for relative in package["files"]}
        self.assertEqual(staging.validate_destination(destination, package,
                                                      owner_uid=self.owner_uid), "REUSED")
        # Creation is a separate, exclusive operation, even for an exact tree.
        with self.assertRaises((staging.StagingError, FileExistsError)):
            staging.stage_package(destination, package, owner_uid=self.owner_uid)
        after = {relative: ((destination / relative).stat().st_ino,
                            (destination / relative).stat().st_mtime_ns,
                            (destination / relative).read_bytes())
                 for relative in package["files"]}
        self.assertEqual(before, after)

    def test_pin_hash_and_metadata_must_all_match(self):
        changes = {"manifestSha256": "0" * 64, "sourceCommit": "b" * 40,
                   "base": "/different/", "fileCount": len(self.contents) + 1}
        original = dict(self.pin)
        for field, value in changes.items():
            with self.subTest(field=field):
                self.pin = {**original, field: value}
                with self.assertRaises(staging.StagingError):
                    self.scan()
        self.pin = original

    def test_changed_manifest_and_same_size_changed_file_are_rejected(self):
        manifest_path = self.source / "release-manifest.json"
        original = manifest_path.read_bytes()
        manifest_path.write_bytes(original + b"\n")
        with self.assertRaises(staging.StagingError):
            self.scan()
        manifest_path.write_bytes(original)
        path = self.source / "assets/app.js"
        previous = path.stat()
        path.write_bytes(b"x" * len(self.contents["assets/app.js"]))
        os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_duplicate_and_stale_declared_file_metadata_are_rejected(self):
        original = json.loads(json.dumps(self.manifest))
        for mutation in ("duplicate", "size", "digest"):
            with self.subTest(mutation=mutation):
                self.manifest = json.loads(json.dumps(original))
                if mutation == "duplicate":
                    self.manifest["files"].append(dict(self.manifest["files"][0]))
                elif mutation == "size":
                    self.manifest["files"][0]["bytes"] += 1
                else:
                    self.manifest["files"][0]["sha256"] = "0" * 64
                self.save_manifest()
                with self.assertRaises(staging.StagingError):
                    self.scan()

    def test_manifest_paths_cannot_escape_or_include_repository_and_dotenv_files(self):
        outside = self.root / "outside.txt"
        outside.write_bytes(b"outside fixture")
        invalid = ("../outside.txt", str(outside), "assets/../index.html", "./index.html",
                   ".git/config", "assets/.git/config", ".env", "assets/.env.production")
        for number, relative in enumerate(invalid):
            with self.subTest(relative=relative):
                self.source = self.root / ("unsafe-path-" + str(number))
                self.source.mkdir(mode=0o700)
                self.write_private(self.source / relative, b"outside fixture")
                self.manifest["files"] = [self.entry(relative, b"outside fixture")]
                self.save_manifest()
                with self.assertRaises(staging.StagingError):
                    self.scan()
        self.assertEqual(outside.read_bytes(), b"outside fixture")

    def test_unlisted_source_file_is_rejected(self):
        self.write_private(self.source / "unlisted.txt", b"not in the approved manifest")
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_source_symlinks_and_hardlinks_are_rejected(self):
        path = self.source / "index.html"
        outside = self.root / "outside.html"
        path.rename(outside)
        path.symlink_to(outside)
        with self.assertRaises(staging.StagingError):
            self.scan()
        path.unlink()
        os.link(outside, path)
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_source_symlink_directory_and_manifest_are_rejected(self):
        assets = self.source / "assets"
        moved = self.root / "outside-assets"
        assets.rename(moved)
        assets.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(staging.StagingError):
            self.scan()
        assets.unlink()
        moved.rename(assets)
        manifest = self.source / "release-manifest.json"
        moved_manifest = self.root / "outside-manifest.json"
        manifest.rename(moved_manifest)
        manifest.symlink_to(moved_manifest)
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_wrong_source_owner_and_writable_source_are_rejected(self):
        with self.assertRaises(staging.StagingError):
            self.scan(owner_uid=self.owner_uid + 1)
        path = self.source / "index.html"
        path.chmod(0o666)
        with self.assertRaises(staging.StagingError):
            self.scan()
        path.chmod(0o600)
        self.source.chmod(0o777)
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_too_many_manifest_files_are_rejected(self):
        for relative in self.contents:
            (self.source / relative).unlink()
        (self.source / "assets").rmdir()
        self.manifest["files"] = []
        for number in range(1001):
            relative = "many/" + str(number) + ".txt"
            self.write_private(self.source / relative, b"x")
            self.manifest["files"].append(self.entry(relative, b"x"))
        self.save_manifest()
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_package_over_32_mib_is_rejected(self):
        content = b"x" * (32 * 1024 * 1024 + 1)
        self.write_private(self.source / "assets/app.js", content)
        self.manifest["files"] = [self.entry(relative, content if relative == "assets/app.js" else data)
                                  for relative, data in sorted(self.contents.items())]
        self.save_manifest()
        with self.assertRaises(staging.StagingError):
            self.scan()

    def test_existing_wrong_missing_extra_files_and_extra_directories_are_rejected(self):
        package = self.scan()
        for mutation in ("wrong", "missing", "extra_file", "extra_directory"):
            with self.subTest(mutation=mutation):
                destination = self.stage(package)
                if mutation == "wrong":
                    (destination / "index.html").write_bytes(b"x" * len(self.contents["index.html"]))
                elif mutation == "missing":
                    (destination / "index.html").unlink()
                elif mutation == "extra_file":
                    (destination / "unknown.txt").write_bytes(b"unknown fixture")
                else:
                    (destination / "unknown-directory").mkdir(mode=0o755)
                self.assert_destination_rejected(destination, package)

    def test_existing_tree_requires_exact_public_modes_and_owner(self):
        package = self.scan()
        for relative, mode in (("index.html", 0o600), ("assets", 0o700), (".", 0o700)):
            with self.subTest(relative=relative):
                destination = self.stage(package)
                (destination / relative).chmod(mode)
                self.assert_destination_rejected(destination, package)
        destination = self.stage(package)
        with self.assertRaises(staging.StagingError):
            staging.validate_destination(destination, package, owner_uid=self.owner_uid + 1)

    def test_existing_symlinks_hardlinks_and_symlink_root_are_rejected(self):
        package = self.scan()
        for link_type in ("symlink", "hardlink"):
            with self.subTest(link_type=link_type):
                destination = self.stage(package)
                path = destination / "index.html"
                outside = self.root / (link_type + "-outside.html")
                path.rename(outside)
                if link_type == "symlink":
                    path.symlink_to(outside)
                else:
                    os.link(outside, path)
                self.assert_destination_rejected(destination, package)
        real_destination = self.stage(package)
        linked_destination = self.destination()
        linked_destination.symlink_to(real_destination, target_is_directory=True)
        self.assert_destination_rejected(linked_destination, package)

    def test_preexisting_unknown_destination_is_never_overwritten_or_deleted(self):
        package = self.scan()
        destination = self.destination()
        destination.mkdir(mode=0o755)
        unknown = destination / "unknown.txt"
        unknown.write_bytes(b"must survive an exclusive-create failure")
        with self.assertRaises((staging.StagingError, FileExistsError)):
            staging.stage_package(destination, package, owner_uid=self.owner_uid)
        self.assertEqual(list(destination.iterdir()), [unknown])
        self.assertEqual(unknown.read_bytes(), b"must survive an exclusive-create failure")

    def test_file_created_during_partial_staging_is_never_overwritten_or_deleted(self):
        package = self.scan()
        destination = self.destination()
        sentinel = b"unknown concurrent file must survive"
        original_open = os.open
        attempted_flags = []

        def race_open(path, flags, *args, **kwargs):
            if flags & os.O_CREAT and Path(path).name == "index.html":
                attempted_flags.append(flags)
                (destination / "index.html").write_bytes(sentinel)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(staging.os, "open", side_effect=race_open):
            with self.assertRaises((staging.StagingError, OSError)):
                staging.stage_package(destination, package, owner_uid=self.owner_uid)
        self.assertTrue(attempted_flags, "fixture must reach an exclusive file-create attempt")
        self.assertTrue(all(flags & os.O_EXCL for flags in attempted_flags))
        self.assertEqual((destination / "index.html").read_bytes(), sentinel)


if __name__ == "__main__":
    unittest.main()
