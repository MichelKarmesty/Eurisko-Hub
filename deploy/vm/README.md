# Deploying to an always-on VM (Option E)

The tunnel deployment in `docs/deploy.md` gives you a public URL in minutes, but
it lives on your laptop: when the PC sleeps, reboots or loses power, the URL
dies. This option moves the app onto a small cloud VM instead, so the URL keeps
working whether or not your own machine is switched on.

It costs nothing if you use a provider's free tier, and it needs no domain name.

## What you get

| | |
|---|---|
| **URL** | `https://<dashed-public-ip>.sslip.io` |
| **Fallback** | `http://<public-ip>:8080` — plain HTTP, in case certificate issuance ever fails |
| **Certificate** | obtained and renewed automatically by Caddy (Let's Encrypt) |
| **Survives** | your PC being off, reboots, crashes, logouts |
| **Cost** | $0 on Oracle Cloud Always Free (or GCP free tier) |
| **Domain needed** | no — `sslip.io` is public wildcard DNS that resolves a name back to the IP inside it |

Everything runs from two Docker containers that restart themselves:

- `app` — the same single production container as everywhere else
  (`deploy/server.mjs`: built web client + the NestJS API it supervises)
- `caddy` — terminates TLS on 80/443 and reverse-proxies to the app

Docker's `restart: unless-stopped` is the whole supervision story: after a reboot
both containers come back on their own, with no systemd unit to maintain.

## 1. Create the VM

Oracle Cloud's **Always Free** tier is the recommended host, because — unlike
AWS and GCP — it does not charge for a public IPv4 address, and it keeps the
instance free for the life of the account rather than for 12 months.

1. Sign up at <https://www.oracle.com/cloud/free/>. A card is required for
   identity verification; Always Free resources are not charged.
2. **Choose your Home Region carefully — it cannot be changed later.** Pick one
   near you. If instance creation later fails with *out of host capacity*, that
   is a regional shortage, not an account problem.
3. **Compute → Instances → Create instance**
   - **Image:** Ubuntu 24.04 (marked *Always Free-eligible*)
   - **Shape:** `VM.Standard.A1.Flex` (Arm), **2 OCPU / 12 GB** — this is the
     whole Always Free Arm allowance and is comfortable for the image build
   - **Networking:** a VCN with a **public** subnet, and **assign a public IPv4
     address**
   - **SSH keys:** upload your public key, or let Oracle generate a key pair and
     download the private key
4. **Reserve the public IP** so it never changes: *Instance → Attached VNICs →
   the VNIC → IP addresses → the public IP → Edit → Reserved*. Reserved public
   IPs are free on OCI.

   This matters: your URL is derived from that address, and reserving it is what
   makes the URL permanent. An ephemeral address can change if the instance is
   stopped and started.

### Open the cloud firewall — this is the step everyone misses

The host firewall is handled by `bootstrap.sh`, but the provider's own network
filter is not. If you skip this, the app runs perfectly and is still unreachable
from the internet.

Oracle: **Networking → Virtual Cloud Networks → your VCN → Security Lists →
Default Security List → Add Ingress Rules**

| Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | TCP | `8080` (the fallback; omit to keep it HTTPS-only) |
| `0.0.0.0/0` | TCP | `22` (usually already present) |

On GCP the equivalent is **VPC network → Firewall → Create rule** allowing
`tcp:80,443,8080` from `0.0.0.0/0`.

## 2. Deploy

SSH into the VM and run the bootstrap:

```bash
ssh ubuntu@<public-ip>

git clone https://github.com/MichelKarmesty/Eurisko-Hub.git /opt/eurisko-hub
sudo bash /opt/eurisko-hub/deploy/vm/bootstrap.sh
```

If `deploy/vm/` is not in the repository yet, copy it up first from the machine
that has it:

```bash
scp -r deploy/vm ubuntu@<public-ip>:/tmp/eurisko-vm
ssh ubuntu@<public-ip> 'git clone https://github.com/MichelKarmesty/Eurisko-Hub.git /opt/eurisko-hub \
  && sudo mkdir -p /opt/eurisko-hub/deploy/vm \
  && sudo cp /tmp/eurisko-vm/* /opt/eurisko-hub/deploy/vm/ \
  && sudo bash /opt/eurisko-hub/deploy/vm/bootstrap.sh'
```

The script is idempotent. It installs Docker, opens the host firewall, clones the
repository, generates `JWT_SECRET` and an admin password, builds the image,
starts both containers, waits for the API to answer, waits for the certificate,
and installs a keepalive timer. Re-run it any time to redeploy.

At the end it prints the URL and the generated admin password — **that password
is shown once.**

### Optional settings

Copy `vm.env.example` to `vm.env` before running to change any of these:

| Setting | Default |
|---|---|
| `SITE_ADDRESS` | `<dashed-public-ip>.sslip.io`, or your own domain if you have one |
| `ADMIN_EMAIL` | `admin@eurisko.com` |
| `ADMIN_PASSWORD` | generated randomly; required if you want a known one |
| `ACME_EMAIL` | unset — only used for certificate expiry notices |
| `GIT_REF` | the default branch; pin a commit SHA to freeze the deployment |

`SITE_ADDRESS` regenerates `APP_BASE_URL`, so password-reset links point at the
public URL rather than at localhost.

## 3. Verify it from somewhere else

Run this from your own machine, not the VM — a VM reaching its own public address
depends on hairpin NAT, which not every provider supports:

```bash
LIVE=https://<dashed-public-ip>.sslip.io

curl -s -o /dev/null -w 'health   %{http_code}\n' "$LIVE/api/health"
curl -s -o /dev/null -w 'web root %{http_code}\n' "$LIVE/"
curl -s -X POST "$LIVE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@eurisko.com","password":"<ADMIN_PASSWORD>"}' \
  -o /dev/null -w 'login    %{http_code}\n'

node scripts/final-smoke.mjs --api "$LIVE/api"
node scripts/pre-defense.mjs --sha "$(git rev-parse HEAD)" --live "$LIVE"
```

Then open the URL on a phone using mobile data — a different network from the VM
and from your Wi-Fi — and confirm the sign-in page loads.

## 4. Operating it

```bash
cd /opt/eurisko-hub/deploy/vm

docker compose ps                  # both containers should say "Up"
docker compose logs -f app         # application log
docker compose logs caddy          # certificate and access log
docker compose up -d --build       # redeploy after `git pull`
docker compose restart app         # restart just the app
```

**Data.** Everything (users, tickets) lives in the `eurisko-data` Docker volume at
`/data/hub.sqlite`. It survives restarts, rebuilds and reboots. To back it up:

```bash
docker run --rm -v eurisko-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/hub-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .
```

To rotate the admin password, edit `ADMIN_PASSWORD` in `deploy/vm/.env` and
restart — the seed only applies when the account does not already exist, so for
an existing account change it in the app, or delete the database to start fresh.

## 5. Cost and caveats

- **Always Free is genuinely free** for 2 OCPU / 12 GB Arm, 200 GB of storage and
  10 TB/month of egress, for the life of the account — and OCI does not bill for
  public IP addresses.
- **Oracle may reclaim an idle Always Free instance.** Their policy flags an
  instance whose 95th-percentile CPU, network and (on Arm) memory utilisation all
  stay under 20% across 7 days. The bootstrap installs a 5-minute health ping,
  which keeps the instance in use, but the durable fix is to **upgrade the account
  to Pay As You Go**: Always Free resources stay free, and capacity and
  reclamation stop being a concern.
- **`sslip.io` is a third-party DNS service.** It is widely used and stable, but
  it is not yours. If it ever disappeared you would point a real domain at the
  reserved IP and set `SITE_ADDRESS` — the deployment itself would not change.
- **The seeded admin password is in this repository** (`Admin123!` is the
  published default). `bootstrap.sh` generates a random one instead; do not
  override it with the default for a URL you hand to a grader.
- **Outbound TCP 25 is blocked** on free OCI tenancies, so the app cannot send
  mail directly. Nothing in this project depends on it.

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| URL times out, `docker compose ps` says `Up` | the cloud firewall — the ingress rules in step 1 are missing |
| Certificate never issues, fallback HTTP works | ports 80/443 not open end to end; ACME needs port 80 reachable. Check `docker compose logs caddy` |
| `curl https://…sslip.io` fails from the VM but works from your laptop | hairpin NAT; not a problem |
| Sign-in works but the page is blank | `frontend/dist` was not built; rerun `docker compose up -d --build` and read the build log |
| Data disappeared after a redeploy | the `eurisko-data` volume was removed, or `DB_FILE` no longer points into `/data` |
| `out of host capacity` when creating the instance | regional Arm shortage — retry, try another availability domain, or pick a different home region |
