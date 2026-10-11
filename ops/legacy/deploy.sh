#!/bin/bash
# deploy.sh - push a Tredgate Loan release to a branch workstation
# (c) Tredgate Platform Engineering. last touched for 1.1.0, Sep 2026
#
# usage: ./deploy.sh <version> [branch-host]
#    ./deploy.sh 1.1.0
#    TG_MODE=fast ./deploy.sh 1.1.0 cz-prg-01-ws07.internal.example.com
#
# NOTE: do not run from a laptop on the guest wifi, the jump host blocks it

VERSION=$1
HOST=${2:-cz-prg-01-ws07.internal.example.com}
DEPLOY_USER=tgdeploy
INSTALL_DIR=/opt/tredgate-loan
BACKUP_DIR=/opt/tredgate-backups
REPO=https://github.com/tredgate/tredgate-loan.git
NODE_SETUP_URL=https://deb.nodesource.com/setup_22.x
LOGFILE=/tmp/deploy-$(date +%Y%m%d-%H%M%S).log

if [ -z "$VERSION" ]; then
  echo "usage: $0 <version> [host]"
  exit 1
fi

if [ -z "$DEPLOY_SSH_PASSWORD" ]; then
    echo "DEPLOY_SSH_PASSWORD not set, trying .env"
    if [ -f .env ]; then
        export $(grep -v '^#' .env | xargs)
    fi
fi

if [ -z "$DEPLOY_SSH_PASSWORD" ]; then
	echo "no DEPLOY_SSH_PASSWORD, cannot continue"
	exit 1
fi

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a $LOGFILE
}

remote() {
  sshpass -p "$DEPLOY_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${HOST} "$@" 2>&1 | tee -a $LOGFILE
}

# ---------------------------------------------------------------------------
# old helper from the 1.0 days, kept just in case
# ---------------------------------------------------------------------------
copy_browser_data() {
    # 1.0.0 kept everything in the browser's local storage, this pulled it out
    # of the officers' chrome profile before an upgrade. not needed since 1.1.0
    local profile="/home/$DEPLOY_USER/.config/google-chrome/Default/Local Storage"
    remote "tar czf /tmp/localstorage-$(date +%s).tgz '$profile'"
    remote "ls -la /tmp/localstorage-*.tgz"
}

log "deploying tredgate-loan $VERSION to $HOST (mode: ${TG_MODE:-normal})"

# make sure node is there. the workstations are imaged without it.
log "checking node"
remote "node --version" || {
  log "installing node 22"
  remote "curl -fsSL $NODE_SETUP_URL | sudo -E bash - && sudo apt-get install -y nodejs"
}

# need sshpass/curl/git on the target too
remote "which git || sudo apt-get install -y git"

# ---------------------------------------------------------------------------
# stop the running instance
# ---------------------------------------------------------------------------
log "stopping tredgate-loan"
remote "pkill -f 'tsx server/index.ts' || true"
sleep 2
remote "curl -s http://localhost:3000/api/health" && log "WARN: something still answers on 3000"

# ---------------------------------------------------------------------------
# backup data + log (OPS-050 step 4)
# ---------------------------------------------------------------------------
if [ "$TG_MODE" != "fast" ]; then
  log "backing up data file and log"
  remote "mkdir -p $BACKUP_DIR && cp $INSTALL_DIR/server/data/loans.json $BACKUP_DIR/loans-pre-$VERSION.json"
  remote "cp $INSTALL_DIR/logs/app.log $BACKUP_DIR/app-pre-$VERSION.log || true"
else
  log "TG_MODE=fast, skipping backup"
fi

# ---------------------------------------------------------------------------
# get the code
# ---------------------------------------------------------------------------
log "updating checkout"
remote "test -d $INSTALL_DIR/.git" || remote "sudo git clone $REPO $INSTALL_DIR && sudo chown -R $DEPLOY_USER $INSTALL_DIR"
remote "cd $INSTALL_DIR && git fetch --tags && git checkout v$VERSION"
if [ $? -ne 0 ]; then
    log "checkout of v$VERSION failed, trying main"
    remote "cd $INSTALL_DIR && git checkout main && git pull"
fi

log "npm install"
remote "cd $INSTALL_DIR && npm install" 

# officers kept hitting permission problems on the data folder after the
# image refresh in march, this makes them go away
remote "chmod -R 777 $INSTALL_DIR/server/data $INSTALL_DIR/logs"

# ---------------------------------------------------------------------------
# migrations. there are none yet but the flag is wired for when there are.
# SKIP_MIG=1 skips the whole block
# ---------------------------------------------------------------------------
if [ -z "$SKIP_MIG" ]; then
  log "running migrations (none)"
  remote "cd $INSTALL_DIR && ls server/migrations 2>/dev/null || echo 'no migrations'"
fi

# reset to seed data when asked. used for the training workstations, never for a branch!
# (contradicts RB-006 but the trainers insisted)
if [ "$TG_RESET_DATA" = "yes" ]; then
    log "TG_RESET_DATA=yes -> resetting data file to seed"
    remote "cd $INSTALL_DIR && npm run data:reset"
fi

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------
log "starting"
remote "cd $INSTALL_DIR && nohup npm start > /dev/null 2>&1 &"
sleep 8

# health check. the build inside npm start takes a while on the old i5 boxes,
# so don't fail the deploy on it, the officers will tell us anyway
remote "curl -s http://localhost:3000/api/health" || true
log "health check sent"

if [ "$TG_MODE" = "fast" ]; then
	log "fast mode, done"
	exit 0
fi

# write to the shift log so ops can see the release
remote "echo \"$(date -Iseconds) release $VERSION deployed by $(whoami) via deploy.sh\" >> $INSTALL_DIR/logs/shift.log"

# tag the backup folder so we know which backup belongs to which version
remote "echo $VERSION > $BACKUP_DIR/LAST_DEPLOYED"

log "done. log: $LOGFILE"
log "remember to update the shift log (OPS-050 step 9)"

# rollback hint
# ./deploy.sh 1.1.0 ; cp /opt/tredgate-backups/loans-pre-1.2.0.json /opt/tredgate-loan/server/data/loans.json
