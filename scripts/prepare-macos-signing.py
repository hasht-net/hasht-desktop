#!/usr/bin/env python3
"""Prepare Developer ID signing and Apple API-key notarization on a CI runner."""
import os
import pathlib
import tempfile
import uuid

required = ("CSC_LINK", "CSC_KEY_PASSWORD", "ASC_API_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID")
for name in required:
    if not os.environ.get(name):
        raise SystemExit(f"Missing macOS signing configuration: {name}")
directory = pathlib.Path(tempfile.mkdtemp(prefix="hasht-notary-", dir=os.environ["RUNNER_TEMP"]))
key = directory / "AuthKey.p8"
with open(key, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as file:
    file.write(os.environ["ASC_API_KEY_P8"])
values = {
    "CSC_LINK": os.environ["CSC_LINK"],
    "CSC_KEY_PASSWORD": os.environ["CSC_KEY_PASSWORD"],
    "APPLE_API_KEY": str(key),
    "APPLE_API_KEY_ID": os.environ["ASC_KEY_ID"],
    "APPLE_API_ISSUER": os.environ["ASC_ISSUER_ID"],
    "NOTARY_KEY_DIR": str(directory),
}
with open(os.environ["GITHUB_ENV"], "a") as file:
    for name, value in values.items():
        delimiter = "hasht_" + uuid.uuid4().hex
        file.write(f"{name}<<{delimiter}\n{value}\n{delimiter}\n")
print("Prepared Developer ID signing and API-key notarization")
