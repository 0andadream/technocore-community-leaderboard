#!/usr/bin/env python3
"""Offline verify .well-known/technocore-agent.json ownership signature.

Usage:
  python3 scripts/verify-agent-identity.py [.well-known/technocore-agent.json]

Requires: cryptography
Exit 0 = signature matches did:key public key; 2 = malformed; 3 = mismatch.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
MC = b"\xed\x01"


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    pad = 0
    for c in s:
        if c == "1":
            pad += 1
        else:
            break
    full = n.to_bytes((n.bit_length() + 7) // 8 or 1, "big")
    return b"\x00" * pad + full


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else ".well-known/technocore-agent.json")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        did = doc["did"]
        statement = doc["ownership_statement"]
        sig = doc["signature"]
        if not did.startswith("did:key:z") or doc.get("alg") != "Ed25519":
            print("malformed: expected did:key Ed25519 record", file=sys.stderr)
            return 2
        multicodec = b58decode(did[len("did:key:z") :])
        if multicodec[:2] != MC or len(multicodec) != 34:
            print("malformed: did:key is not Ed25519", file=sys.stderr)
            return 2
        pub = Ed25519PublicKey.from_public_bytes(multicodec[2:])
        pad = "=" * ((4 - len(sig) % 4) % 4)
        pub.verify(base64.urlsafe_b64decode(sig + pad), statement.encode("utf-8"))
    except (KeyError, ValueError, json.JSONDecodeError) as e:
        print(f"malformed: {e}", file=sys.stderr)
        return 2
    except InvalidSignature:
        print("mismatch: signature does not verify for this DID", file=sys.stderr)
        return 3
    print(f"verified: {did}")
    print(f"owner: {doc.get('owner')}")
    print(f"github: {doc.get('github')}")
    print(f"x: {doc.get('x')}")
    print(f"statement: {statement}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
