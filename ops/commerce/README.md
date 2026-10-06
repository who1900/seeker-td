# Standalone commerce deployment templates

Templates only: nothing has been installed or deployed. Confirm the domain and trusted credentials
before provisioning. `commerce.example.invalid` is not a usable URL; do not substitute
`td.whoim.space` without the owner's domain choice. Preserve the shared Node 20 runtime and existing services.

Deployment requirements:

- An isolated, unprivileged system user/group `seeker-td-commerce`, without a login shell.
- Dedicated **Node 22** at `/opt/seeker-td/runtime/node22/bin/node`; the unit checks its major version.
  Do not change `/usr/bin/node`, global npm packages, Docker, or the shared runtime.
- A read-only release at `/opt/seeker-td/server`, using the existing server lock/dependencies.
  Root owns the release and runtime; the service user cannot modify code.
- Outside Git: `/etc/seeker-td/commerce.env`, root-owned `0600`; systemd reads it before switching user.
  `/etc/seeker-td` is root:seeker-td-commerce `0750`, allowing traversal to credentials.
  ADC: `/etc/seeker-td/credentials/firebase-admin.env`, root:seeker-td-commerce `0640`, parent directory `0750`.
  This private `.env` file contains service-account **JSON**, not shell assignments; ADC does not require `.json`.
  Use a trusted service account belonging to the existing Firebase project, with the required Admin permissions.
  These templates do not generate credentials or change IAM.
- Keep Firebase Spark; no Cloud Functions deployment, Blaze upgrade, mainnet, or transfers.
  Bind strictly to `127.0.0.1:8787`; do not expose the port through a firewall/security group.
  If the port changes, update `COMMERCE_NODE_PORT`, nginx `proxy_pass`, and its explicit `Host` together.
- Use Certbot for TLS after confirming the domain/DNS. The template is an HTTPS vhost only;
  align certificate paths with Certbot. Do not replace shared nginx configuration or enable a vhost
  before its certificate exists.

Before every reload (these commands have **not** been executed):

```sh
sudo nginx -t
# Reload only if nginx -t succeeded:
sudo systemctl reload nginx
```

After starting the dedicated service, check locally:

```sh
curl --fail --max-time 2 http://127.0.0.1:8787/ready
```

`/ready` checks constructed runtime, listener/admission, and shutdown state only.
It does **not** prove live ADC validity, Firebase IAM/quota, RPC/genesis, FX, mint/ATA, or payment readiness.
Nginx does not expose `/ready`, add CORS, or retry POST automatically.
Rate/connection limits supplement Node admission; they do not guarantee staying within Spark quotas.
The proxy must not collapse duplicate Authorization/Origin/Content-Type into a valid single value:
verify duplicate-header and slow-body requests through the actual nginx before publication.
Linux nginx/systemd template validation remains a pre-deployment check, not a completed test.
