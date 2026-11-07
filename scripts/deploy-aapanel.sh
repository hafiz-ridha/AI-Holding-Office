#!/usr/bin/env bash
# =====================================================================================
#  AI Holding Office — deploy / update on a VPS with aaPanel + Docker (single container)
# -------------------------------------------------------------------------------------
#  Quick start (as root on the VPS, Docker already installed from aaPanel App Store):
#    curl -fsSL https://raw.githubusercontent.com/hafiz-ridha/AI-Holding-Office/main/scripts/deploy-aapanel.sh -o deploy.sh
#    bash deploy.sh install --domain office.example.com
#
#  Commands:  install | update | backup | status | logs | restart | stop | help
#  The script never edits aaPanel's Nginx/website configuration: it prints the reverse-proxy
#  steps for you to apply in the aaPanel UI.
# =====================================================================================
set -Eeuo pipefail

# ---------- defaults (override with flags or environment variables) ----------
REPO_URL="${REPO_URL:-https://github.com/hafiz-ridha/AI-Holding-Office.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-}"
HOST_PORT="${HOST_PORT:-}"
DOMAIN="${DOMAIN:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
CREATE_SWAP=0
ASSUME_YES=0
CONTAINER="ai-virtual-holding"
SERVICE="ai-holding"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
APP_UID=1000

# ---------- output helpers ----------
if [[ -t 1 ]]; then C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_C=$'\e[36m'; C_0=$'\e[0m'; else C_B=; C_G=; C_Y=; C_R=; C_C=; C_0=; fi
step() { printf '\n%s==> %s%s\n' "$C_B$C_C" "$*" "$C_0"; }
ok()   { printf '%s✔%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%s✖ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }
trap 'die "Gagal di baris $LINENO (perintah: $BASH_COMMAND)"' ERR

usage() {
  cat <<EOF
${C_B}AI Holding Office — deploy untuk aaPanel + Docker${C_0}

Pemakaian:  bash deploy-aapanel.sh <perintah> [opsi]

Perintah:
  install    Pasang pertama kali atau pasang ulang (idempoten): ambil kode, buat .env, build, jalankan
  update     Backup database, tarik kode terbaru, build ulang, jalankan (data & .env dipertahankan)
  backup     Backup database sekarang ke data/backups/ (tampil juga di dashboard → Settings)
  status     Status container, health check, dan pemakaian RAM/CPU
  logs       Tampilkan log container (Ctrl+C untuk keluar)
  restart    Restart container
  stop       Hentikan container (data tetap aman)
  help       Tampilkan bantuan ini

Opsi:
  --dir PATH        Folder aplikasi (default: /www/wwwroot/ai-holding, atau checkout tempat skrip ini berada)
  --domain DOMAIN   Domain dashboard, mis. office.example.com (mengisi APP_URL di .env)
  --port PORT       Port di 127.0.0.1 untuk reverse proxy aaPanel (default 3000)
  --branch NAME     Branch git (default: main)
  --repo URL        URL repository git (default: ${REPO_URL})
  --admin-user NAME Username admin pertama (default: admin)
  --create-swap     Buat swapfile 1 GB bila RAM < 2 GB dan belum ada swap (mengubah sistem; opsional)
  -y, --yes         Jangan bertanya konfirmasi

Contoh:
  bash deploy-aapanel.sh install --domain office.example.com
  bash deploy-aapanel.sh update
  bash deploy-aapanel.sh backup
EOF
}

# ---------- argument parsing ----------
CMD="${1:-help}"
[[ $# -gt 0 ]] && shift
DIR_FROM_FLAG=0
PORT_FROM_FLAG=0
DOMAIN_FROM_FLAG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="${2:?--dir butuh nilai}"; DIR_FROM_FLAG=1; shift 2 ;;
    --domain) DOMAIN="${2:?--domain butuh nilai}"; DOMAIN_FROM_FLAG=1; shift 2 ;;
    --port) HOST_PORT="${2:?--port butuh nilai}"; PORT_FROM_FLAG=1; shift 2 ;;
    --branch) BRANCH="${2:?--branch butuh nilai}"; shift 2 ;;
    --repo) REPO_URL="${2:?--repo butuh nilai}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:?--admin-user butuh nilai}"; shift 2 ;;
    --create-swap) CREATE_SWAP=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) CMD=help; shift ;;
    *) die "Opsi tidak dikenal: $1 (lihat: bash deploy-aapanel.sh help)" ;;
  esac
done
[[ -n "$DOMAIN" ]] && DOMAIN="${DOMAIN#http://}" && DOMAIN="${DOMAIN#https://}" && DOMAIN="${DOMAIN%%/*}"
if [[ -n "$HOST_PORT" && ! "$HOST_PORT" =~ ^[0-9]+$ ]]; then die "--port harus angka"; fi

# Default folder: the checkout containing this script, else /www/wwwroot/ai-holding.
if [[ -z "$APP_DIR" ]]; then
  SELF="${BASH_SOURCE[0]:-}"
  if [[ -n "$SELF" && -f "$SELF" ]]; then
    CANDIDATE="$(cd "$(dirname "$SELF")/.." 2>/dev/null && pwd || true)"
    [[ -n "$CANDIDATE" && -f "$CANDIDATE/docker-compose.yml" && -d "$CANDIDATE/src" ]] && APP_DIR="$CANDIDATE"
  fi
  APP_DIR="${APP_DIR:-/www/wwwroot/ai-holding}"
fi

# ---------- privilege helper ----------
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
fi
need_root() {
  if [[ "$(id -u)" -ne 0 && -z "$SUDO" ]]; then die "Jalankan sebagai root (atau pasang sudo)."; fi
}

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -t 0 ]] || return 0
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[YyJj]$ ]]
}

# ---------- docker helpers ----------
COMPOSE=()
detect_compose() {
  command -v docker >/dev/null 2>&1 || die "Docker belum terpasang. Pasang lewat aaPanel → App Store → Docker, lalu jalankan ulang."
  $SUDO docker info >/dev/null 2>&1 || die "Docker daemon tidak berjalan. Coba: systemctl start docker"
  if $SUDO docker compose version >/dev/null 2>&1; then COMPOSE=($SUDO docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=($SUDO docker-compose)
  else die "Docker Compose tidak ditemukan. Perbarui Docker dari aaPanel (paket compose plugin)."; fi
}
compose() { (cd "$APP_DIR" && "${COMPOSE[@]}" "$@"); }
container_running() { [[ "$($SUDO docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == "true" ]]; }

# ---------- .env helpers ----------
env_get() { [[ -f "$2" ]] && grep -E "^$1=" "$2" | tail -n 1 | cut -d= -f2- || true; }
env_set() {
  local key="$1" val="$2" file="$3"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$val" 'index($0, k"=")==1 { print k"="v; next } { print }' "$file" > "$file.tmp" && cat "$file.tmp" > "$file" && rm -f "$file.tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}
rand_b64() { if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1" | tr -d '\n'; else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi; }
rand_password() { rand_b64 24 | tr -d '/+=' | cut -c1-18; }

# ---------- steps ----------
preflight() {
  step "Pemeriksaan sistem"
  [[ "$(uname -s)" == "Linux" ]] || warn "Skrip ini ditujukan untuk Linux (VPS aaPanel). Sistem terdeteksi: $(uname -s)"
  need_root
  for c in git curl; do command -v "$c" >/dev/null 2>&1 || die "Perintah '$c' tidak ditemukan. Pasang dulu (apt/yum install $c)."; done
  detect_compose
  ok "Docker: $($SUDO docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') · Compose: $("${COMPOSE[@]}" version --short 2>/dev/null || echo '?')"
  if command -v free >/dev/null 2>&1; then
    local mem swap
    mem=$(free -m | awk '/^Mem:/ {print $2}')
    swap=$(free -m | awk '/^Swap:/ {print $2}')
    ok "RAM ${mem} MB · swap ${swap} MB"
    if [[ "${mem:-0}" -lt 2048 && "${swap:-0}" -eq 0 ]]; then
      if [[ $CREATE_SWAP -eq 1 ]]; then create_swap
      else warn "RAM < 2 GB tanpa swap. Disarankan swap 1 GB (aaPanel → Linux Tools → Swap, atau jalankan ulang dengan --create-swap)."; fi
    fi
  fi
  local avail
  avail=$(df -Pm "$(dirname "$APP_DIR")" 2>/dev/null | awk 'NR==2 {print $4}' || echo "")
  [[ -n "$avail" && "$avail" -lt 1024 ]] && warn "Sisa disk hanya ${avail} MB; build image butuh ±500 MB."
  return 0
}

create_swap() {
  [[ -e /swapfile ]] && { warn "/swapfile sudah ada; dilewati."; return 0; }
  step "Membuat swapfile 1 GB (--create-swap)"
  $SUDO fallocate -l 1G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  ok "Swap 1 GB aktif"
}

fetch_code() {
  step "Kode aplikasi → $APP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then
    if [[ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]]; then
      die "Ada perubahan lokal pada file yang dilacak git di $APP_DIR. Simpan/commit atau batalkan dulu (git -C $APP_DIR status)."
    fi
    git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    git -C "$APP_DIR" checkout --quiet "$BRANCH"
    local before after
    before=$(git -C "$APP_DIR" rev-parse --short HEAD)
    git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH"
    after=$(git -C "$APP_DIR" rev-parse --short HEAD)
    [[ "$before" == "$after" ]] && ok "Sudah versi terbaru ($after)" || ok "Diperbarui $before → $after"
  elif [[ -f "$APP_DIR/docker-compose.yml" && -d "$APP_DIR/src" ]]; then
    ok "Memakai source code yang sudah ada (bukan checkout git; update dilakukan manual)"
  elif [[ -d "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    die "$APP_DIR sudah berisi file lain. Pilih folder kosong dengan --dir."
  else
    $SUDO mkdir -p "$(dirname "$APP_DIR")"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    ok "Clone $REPO_URL ($BRANCH) → $(git -C "$APP_DIR" rev-parse --short HEAD)"
  fi
}

GENERATED_PASSWORD=""
prepare_env() {
  step "Konfigurasi .env"
  local env="$APP_DIR/.env"
  local fresh=0
  if [[ ! -f "$env" ]]; then
    cp "$APP_DIR/.env.example" "$env"
    fresh=1
  fi
  chmod 600 "$env"
  # APP_SECRET encrypts stored API keys. Never replace an existing one.
  local secret
  secret="$(env_get APP_SECRET "$env")"
  if [[ -z "$secret" ]]; then
    if [[ -s "$APP_DIR/data/.app_secret" ]]; then
      secret="$($SUDO cat "$APP_DIR/data/.app_secret")"
      ok "APP_SECRET diambil dari data/.app_secret yang sudah dipakai aplikasi"
    elif [[ -f "$APP_DIR/data/office.db" ]]; then
      die "Database sudah ada tetapi APP_SECRET kosong dan data/.app_secret tidak ditemukan. Isi APP_SECRET lama di $env agar API key tersimpan tetap terbaca."
    else
      secret="$(rand_b64 48)"
      ok "APP_SECRET baru dibuat (simpan salinan .env di tempat aman)"
    fi
    env_set APP_SECRET "$secret" "$env"
  elif [[ ${#secret} -lt 32 ]]; then
    die "APP_SECRET di $env kurang dari 32 karakter."
  fi
  # First admin password: only matters before the first boot (no users yet).
  if [[ ! -f "$APP_DIR/data/office.db" && -z "$(env_get ADMIN_PASSWORD "$env")" ]]; then
    GENERATED_PASSWORD="$(rand_password)"
    env_set ADMIN_PASSWORD "$GENERATED_PASSWORD" "$env"
    env_set ADMIN_USERNAME "$ADMIN_USER" "$env"
  fi
  if [[ $PORT_FROM_FLAG -eq 1 || $fresh -eq 1 ]]; then env_set HOST_PORT "${HOST_PORT:-3000}" "$env"; fi
  if [[ -n "$DOMAIN" && ( $DOMAIN_FROM_FLAG -eq 1 || $fresh -eq 1 ) ]]; then env_set APP_URL "https://$DOMAIN" "$env"; fi
  HOST_PORT="$(env_get HOST_PORT "$env")"
  HOST_PORT="${HOST_PORT:-3000}"
  ok ".env siap (port 127.0.0.1:$HOST_PORT${DOMAIN:+, domain $DOMAIN})"
}

prepare_data() {
  step "Folder data persisten"
  $SUDO mkdir -p "$APP_DIR/data/backups"
  $SUDO chown -R "$APP_UID:$APP_UID" "$APP_DIR/data"
  $SUDO chmod 750 "$APP_DIR/data"
  ok "$APP_DIR/data dimiliki uid $APP_UID (user node di container)"
}

check_port() {
  container_running && return 0
  if command -v ss >/dev/null 2>&1 && [[ -n "$(ss -H -ltn "sport = :$HOST_PORT" 2>/dev/null)" ]]; then
    die "Port $HOST_PORT sudah dipakai proses lain. Pilih port lain: --port 3100"
  fi
  return 0
}

backup_db() {
  local reason="${1:-manual}"
  [[ -f "$APP_DIR/data/office.db" ]] || { ok "Belum ada database; backup dilewati"; return 0; }
  local name="manual-$(date -u +%Y%m%d-%H%M%S).db"
  $SUDO mkdir -p "$APP_DIR/data/backups"
  if container_running; then
    # Consistent online snapshot with SQLite VACUUM INTO, executed inside the running container.
    $SUDO docker exec -u node "$CONTAINER" node --disable-warning=ExperimentalWarning -e \
      "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/office.db');db.exec('PRAGMA busy_timeout=10000');db.prepare('VACUUM INTO ?').run(process.argv[1]);db.close();" \
      "/app/data/backups/$name"
  else
    # Container stopped: copy the database together with its WAL file (if any).
    $SUDO cp -p "$APP_DIR/data/office.db" "$APP_DIR/data/backups/$name"
    [[ -f "$APP_DIR/data/office.db-wal" ]] && $SUDO cp -p "$APP_DIR/data/office.db-wal" "$APP_DIR/data/backups/$name-wal"
    $SUDO chown "$APP_UID:$APP_UID" "$APP_DIR/data/backups/$name"*
  fi
  ok "Backup ($reason): data/backups/$name ($($SUDO du -h "$APP_DIR/data/backups/$name" | cut -f1))"
}

build_and_start() {
  step "Build image & jalankan container"
  compose up -d --build --remove-orphans
  $SUDO docker image prune -f >/dev/null 2>&1 || true
  ok "Container $CONTAINER dijalankan"
}

wait_healthy() {
  step "Menunggu aplikasi siap (maks ${HEALTH_TIMEOUT} detik)"
  local i=0 body=""
  while (( i < HEALTH_TIMEOUT )); do
    if body="$(curl -fsS --max-time 3 "http://127.0.0.1:$HOST_PORT/api/health" 2>/dev/null)"; then
      ok "Health OK: $body"
      return 0
    fi
    if ! container_running && (( i > 10 )); then break; fi
    sleep 2
    i=$((i + 2))
  done
  warn "Aplikasi belum merespons. 40 baris log terakhir:"
  compose logs --tail=40 || true
  die "Deploy gagal. Perbaiki penyebab di log di atas lalu jalankan ulang: bash $0 update"
}

summary() {
  local env="$APP_DIR/.env"
  local user
  user="$(env_get ADMIN_USERNAME "$env")"
  step "Selesai"
  printf '  Aplikasi lokal : http://127.0.0.1:%s\n' "$HOST_PORT"
  printf '  Folder         : %s\n' "$APP_DIR"
  printf '  Data & backup  : %s/data (backup: %s/data/backups)\n' "$APP_DIR" "$APP_DIR"
  if [[ -n "$GENERATED_PASSWORD" ]]; then
    printf '\n  %sLogin admin pertama%s\n  Username : %s\n  Password : %s\n' "$C_B" "$C_0" "${user:-admin}" "$GENERATED_PASSWORD"
    printf '  Segera ganti password di dashboard → Settings, lalu hapus nilai ADMIN_PASSWORD dari %s.\n' "$env"
  fi
  cat <<EOF

  ${C_B}Langkah di aaPanel (manual, skrip tidak mengubah konfigurasi server):${C_0}
   1. Website → Add site → domain ${DOMAIN:-anda} (Static / tanpa PHP, tanpa database).
   2. Site → Reverse proxy → Add: Target URL  http://127.0.0.1:${HOST_PORT}  · Send domain  \$host
   3. Site → SSL → Let's Encrypt → Apply → aktifkan Force HTTPS.
   4. Pastikan konfigurasi proxy memuat:
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        client_max_body_size 2m;
   5. Buka https://${DOMAIN:-domain-anda} → login → AI Providers (isi API key) → Telegram.

  Perintah berguna:
    bash $0 status | logs | backup | update | restart | stop
EOF
}

cmd_status() {
  detect_compose
  [[ -f "$APP_DIR/docker-compose.yml" ]] || die "Tidak ada instalasi di $APP_DIR (gunakan --dir)."
  HOST_PORT="$(env_get HOST_PORT "$APP_DIR/.env")"; HOST_PORT="${HOST_PORT:-3000}"
  compose ps
  printf '\nHealth container : %s\n' "$($SUDO docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$CONTAINER" 2>/dev/null || echo 'tidak berjalan')"
  printf 'Health HTTP      : %s\n' "$(curl -fsS --max-time 3 "http://127.0.0.1:$HOST_PORT/api/health" 2>/dev/null || echo 'tidak merespons')"
  container_running && $SUDO docker stats --no-stream --format 'RAM/CPU          : {{.MemUsage}} · CPU {{.CPUPerc}}' "$CONTAINER"
  [[ -d "$APP_DIR/.git" ]] && printf 'Versi            : %s\n' "$(git -C "$APP_DIR" log -1 --format='%h %s (%cr)')"
  return 0
}

# ---------- main ----------
case "$CMD" in
  install)
    printf '%sAI Holding Office — install%s → %s\n' "$C_B" "$C_0" "$APP_DIR"
    preflight
    [[ -f "$APP_DIR/data/office.db" ]] && backup_db "sebelum install ulang"
    fetch_code
    prepare_env
    prepare_data
    check_port
    build_and_start
    wait_healthy
    summary
    ;;
  update)
    [[ -f "$APP_DIR/docker-compose.yml" ]] || die "Belum ada instalasi di $APP_DIR. Jalankan: bash $0 install"
    printf '%sAI Holding Office — update%s → %s\n' "$C_B" "$C_0" "$APP_DIR"
    preflight
    backup_db "sebelum update"
    fetch_code
    prepare_env
    prepare_data
    build_and_start
    wait_healthy
    ok "Update selesai. Migrasi database berjalan otomatis (lihat: bash $0 logs)."
    ;;
  backup)
    need_root; detect_compose
    backup_db "manual"
    ;;
  status) need_root; cmd_status ;;
  logs) need_root; detect_compose; compose logs --tail=200 -f ;;
  restart)
    need_root; detect_compose
    compose restart
    HOST_PORT="$(env_get HOST_PORT "$APP_DIR/.env")"; HOST_PORT="${HOST_PORT:-3000}"
    wait_healthy
    ;;
  stop)
    need_root; detect_compose
    confirm "Hentikan container $CONTAINER? (data tetap tersimpan)" || die "Dibatalkan."
    compose stop
    ok "Container dihentikan. Jalankan lagi: bash $0 restart (atau install)"
    ;;
  help|-h|--help) usage ;;
  *) usage; die "Perintah tidak dikenal: $CMD" ;;
esac
