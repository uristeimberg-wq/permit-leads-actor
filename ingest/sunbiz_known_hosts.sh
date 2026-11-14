#!/usr/bin/env bash
# Trusts the Florida Sunbiz SFTP host (sftp.floridados.gov) for curl's SFTP
# (libssh2 reads ~/.ssh/known_hosts; a fresh runner has none, so curl exits
# 60). The host's keys are scanned and appended only if their SHA256
# fingerprints match the ones pinned here (seen by the identity-recon run,
# 2026-11-14). Host-key verification is never turned off: when nothing
# matches, nothing is trusted, curl refuses, and the Sunbiz run records the
# failure. Always exits 0 so that the run itself is what records the outcome.
set -u
HOST=sftp.floridados.gov
PINNED="SHA256:xTpc6X81is5Nyh2QXR6hIRhS7ayx5/BMr162zB73xyQ SHA256:TPtpEBn4t/fjdWpecrIQ0BgLXRAqj9wjDkoCNIggZEE SHA256:Uv7WZDtGBkIOE4QMpvdJp4h46Dx3/idG/jHfiE5bEJA"
tmp=$(mktemp -d)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keyscan -t ed25519,ecdsa,rsa "$HOST" 2>/dev/null > "$tmp/keys" || true
trusted=0
while read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  printf '%s\n' "$line" > "$tmp/key"
  fp=$(ssh-keygen -lf "$tmp/key" 2>/dev/null | awk '{print $2}') || fp=''
  case " $PINNED " in
    *" $fp "*) echo "pinned host key $fp"; printf '%s\n' "$line" >> ~/.ssh/known_hosts; trusted=$((trusted + 1)) ;;
    *) echo "unpinned host key '${fp}'" ;;
  esac
done < "$tmp/keys"
rm -rf "$tmp"
if [ "$trusted" -eq 0 ]; then echo "::error::$HOST: no host key matches a pinned fingerprint; nothing trusted"; fi
exit 0
