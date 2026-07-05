# certs/

Place the Let's Encrypt cert pair here (RUNBOOK.md §3a):

- `fullchain.pem` — leaf + intermediate, mode 444, owner uid 65532
- `privkey.pem` — private key, mode 400, owner uid 65532

Never commit real key material. Both files are copied here from
`/etc/letsencrypt/live/<domain>/` by the certbot deploy hook on every renewal.
