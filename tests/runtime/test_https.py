"""The SDK uses the same authenticated workflow over a real TLS socket."""

from __future__ import annotations

import ipaddress
import socket
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from hhtools.client import RuntimeClient, RuntimeClientError
from hhtools.contracts.runtime import RuntimeTokenRequest
from hhtools.services.runtime_control import RuntimeControl


def test_https_identity_upload_and_subject_scopes(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HHTools integration test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = tmp_path / "server.crt", tmp_path / "server.key"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    workspace = tmp_path / "workspace"
    control = RuntimeControl(workspace / ".hhtools-agent")
    receipt = control.issue_token(RuntimeTokenRequest(subject="agent", scopes=["read", "write"]))
    admin = control.issue_token(RuntimeTokenRequest(subject="admin", scopes=["admin"]))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "hhtools.runtime.daemon",
            "--workspace",
            str(workspace),
            "--remote",
            "--port",
            str(port),
            "--ssl-certfile",
            str(cert_file),
            "--ssl-keyfile",
            str(key_file),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    client = RuntimeClient(
        f"https://127.0.0.1:{port}", token=receipt.token, ca_file=cert_file, timeout=3
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                identity = client.connect()
                break
            except RuntimeClientError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        assert identity["mode"] == "remote"
        assert identity["runtime_id"] == control.identity.runtime_id
        source = tmp_path / "video.mp4"
        source.write_bytes(b"integrity-only-test-video")
        asset = client.upload(source, kind="video")
        assert asset["kind"] == "video"
        assert (
            client.call("hhtools_get_asset", {"asset_id": asset["asset_id"]})["asset_id"]
            == asset["asset_id"]
        )
        try:
            client.call("hhtools_runtime_list_tokens")
        except RuntimeClientError as error:
            assert error.api_error.code == "SCOPE_REQUIRED"
        else:
            raise AssertionError("A non-admin token accessed credential management")
    finally:
        manager = RuntimeClient(
            f"https://127.0.0.1:{port}", token=admin.token, ca_file=cert_file, timeout=3
        )
        try:
            manager.request("POST", "/api/runtime/v1/admin/shutdown", document={"policy": "drain"})
            process.wait(10)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            if process.stderr is not None:
                process.stderr.close()
