/** Start screen + lobby browser (DOM). */

export class GameMenu {
  constructor({
    root,
    onSandbox,
    onOpenMode,
    onBack,
    onClaim,
    onLeaveSeat,
    onEnterMatch,
    onSpectate,
  }) {
    this.root = root;
    this.onSandbox = onSandbox;
    this.onOpenMode = onOpenMode;
    this.onBack = onBack;
    this.onClaim = onClaim;
    this.onLeaveSeat = onLeaveSeat;
    this.onEnterMatch = onEnterMatch;
    this.onSpectate = onSpectate;
    this.screen = 'start'; // start | lobby
    this.mode = null;
    this.username = null;
    this.spaceUrl = null;
    this.authError = null;
    this.playAllowed = true;
    this.selectedLobby = null;

    this.els = {
      start: root.querySelector('#menu-start'),
      lobby: root.querySelector('#menu-lobby'),
      lobbyTitle: root.querySelector('#lobby-title'),
      lobbyList: root.querySelector('#lobby-list'),
      lobbyMeta: root.querySelector('#lobby-meta'),
      userLabel: root.querySelector('#menu-user'),
      err: root.querySelector('#menu-error'),
      btnBack: root.querySelector('#btn-lobby-back'),
      btnEnter: root.querySelector('#btn-lobby-enter'),
      btnLeave: root.querySelector('#btn-lobby-leave'),
    };

    root.querySelector('#btn-mode-sandbox')?.addEventListener('click', () => this._pickMode('sandbox'));
    root.querySelector('#btn-mode-1v1')?.addEventListener('click', () => this._pickMode('1v1'));
    root.querySelector('#btn-mode-4v4')?.addEventListener('click', () => this._pickMode('4v4'));
    this.els.btnBack?.addEventListener('click', () => {
      this.showStart();
      this.onBack?.();
    });
    this.els.btnEnter?.addEventListener('click', () => this.onEnterMatch?.());
    this.els.btnLeave?.addEventListener('click', () => this.onLeaveSeat?.());
  }

  setIdentity({ username, spaceUrl, authError, playAllowed = true }) {
    this.username = username;
    this.spaceUrl = spaceUrl;
    this.authError = authError;
    this.playAllowed = playAllowed !== false;
    if (this.els.userLabel) {
      if (!username) {
        this.els.userLabel.textContent = authError || 'Not signed in — set HF_TOKEN in .env.local';
      } else if (!this.playAllowed) {
        this.els.userLabel.textContent = `Spectator · ${username}`;
      } else if (String(username).startsWith('guest-')) {
        this.els.userLabel.textContent = `Guest · ${username}`;
      } else {
        this.els.userLabel.textContent = `Signed in as ${username}`;
      }
    }
    if (this.els.btnEnter) this.els.btnEnter.hidden = !this.playAllowed;
    if (this.els.btnLeave) this.els.btnLeave.hidden = !this.playAllowed;
    const sub = this.root.querySelector('.menu-sub');
    if (sub) {
      sub.textContent = this.playAllowed
        ? 'Sandbox · 1v1 · 4v4'
        : 'Spectate only — no HF login · play is local-only';
    }
    // Space / spectate host: hide play mode buttons; lobbies are spectate pickers only.
    for (const id of ['btn-mode-sandbox', 'btn-mode-1v1', 'btn-mode-4v4']) {
      const btn = this.root.querySelector(`#${id}`);
      if (btn) btn.hidden = !this.playAllowed;
    }
    if (!this.playAllowed && this.els.start) {
      // Keep brand; modes hidden. Auto-open sandbox spectate list.
      this.showLobby('sandbox');
      this.onOpenMode?.('sandbox');
    }
  }

  show() {
    this.root.hidden = false;
    this.root.classList.add('menu-open');
    this.showStart();
  }

  hide() {
    this.root.hidden = true;
    this.root.classList.remove('menu-open');
  }

  showStart() {
    this.screen = 'start';
    this.mode = null;
    this.selectedLobby = null;
    if (this.els.start) this.els.start.hidden = false;
    if (this.els.lobby) this.els.lobby.hidden = true;
    if (this.els.lobbyList) this.els.lobbyList.innerHTML = '';
    if (this.els.lobbyMeta) this.els.lobbyMeta.textContent = '';
    if (this.els.lobbyTitle) this.els.lobbyTitle.textContent = 'Lobbies';
    this._setError('');
  }

  showLobby(mode) {
    this.screen = 'lobby';
    this.mode = mode;
    if (this.els.start) this.els.start.hidden = true;
    if (this.els.lobby) this.els.lobby.hidden = false;
    if (this.els.lobbyTitle) {
      const titles = { sandbox: 'Sandbox lobbies', '1v1': '1v1 lobbies', '4v4': '4v4 lobbies' };
      this.els.lobbyTitle.textContent = titles[mode] || mode;
    }
  }

  _pickMode(mode) {
    if (!this.username) {
      this._setError(this.authError || 'Set HF_TOKEN in .env.local');
      return;
    }
    if (!this.playAllowed) {
      // Spectate-only host: still browse lobbies to pick Spectate.
      this._setError('');
      this.showLobby(mode);
      this.onOpenMode?.(mode);
      return;
    }
    this._setError('');
    this.showLobby(mode);
    this.onOpenMode?.(mode);
  }

  _setError(msg) {
    if (this.els.err) {
      this.els.err.textContent = msg || '';
      this.els.err.hidden = !msg;
    }
  }

  _seatLabel(seatKey) {
    const m = String(seatKey).match(/^([XYS])-(\d+)$/i);
    if (!m) return { team: null, label: seatKey, cls: '' };
    const t = m[1].toUpperCase();
    return {
      team: t === 'S' ? null : t,
      label: m[2],
      cls: t === 'X' ? 'team-x' : t === 'Y' ? 'team-y' : '',
    };
  }

  _makeSeatBtn(mode, lobby, seat, user) {
    const meta = this._seatLabel(seat);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `seat-btn ${meta.cls}${user ? ' filled' : ''}`.trim();
    const locked =
      !this.playAllowed ||
      !!user ||
      lobby.status === 'live' ||
      lobby.status === 'starting';
    btn.disabled = locked;
    btn.title = locked
      ? (lobby.status === 'live' || lobby.status === 'starting'
        ? `${lobby.id} is ${lobby.status} — pick another lobby or wait ~20s for it to free`
        : (user ? `${user} is seated` : 'Spectate only'))
      : seat;
    btn.innerHTML = user
      ? `${meta.label}<span class="seat-who">${user}</span>`
      : meta.label;
    if (this.playAllowed) {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        try {
          this._setError('');
          btn.disabled = true;
          btn.textContent = '…';
          await this.onClaim?.(mode, lobby.id, seat);
          this.selectedLobby = lobby.id;
        } catch (err) {
          this._setError(err.message || String(err));
        }
      });
    } else if (locked) {
      btn.addEventListener('click', () => {
        this._setError(btn.title || 'Seat locked');
      });
    }
    return btn;
  }

  renderBoard(board, mode, error = null) {
    const list = this.els.lobbyList;
    if (!list) return;
    if (error || !board) {
      list.innerHTML = `<div class="lobby-card"><strong>Waiting for game server…</strong>
        <div class="lobby-seats" style="display:block;margin-top:0.4rem">
        ${error || 'Lobby server not reachable.'}
        </div></div>`;
      this._setError(error || 'Lobby server not ready');
      return;
    }
    this._setError('');
    const key = mode === 'sandbox' ? 'sandbox' : mode === '1v1' ? 'duel' : 'squad';
    const lobbies = board[key] || [];
    list.innerHTML = '';

    for (const lobby of lobbies) {
      const card = document.createElement('div');
      card.className = 'lobby-card';
      card.dataset.id = lobby.id;

      const head = document.createElement('div');
      head.className = 'lobby-card-head';
      head.innerHTML = `<strong>${lobby.id}</strong><span>${lobby.filled}/${lobby.capacity} · ${lobby.status}</span>`;
      card.appendChild(head);

      const seatEntries = Object.entries(lobby.seats || {});
      const xs = seatEntries.filter(([k]) => /^X-/i.test(k));
      const ys = seatEntries.filter(([k]) => /^Y-/i.test(k));

      if (xs.length || ys.length) {
        const row = document.createElement('div');
        row.className = 'lobby-seats teams';
        const left = document.createElement('div');
        left.className = 'team-col team-x';
        const right = document.createElement('div');
        right.className = 'team-col team-y';
        for (const [seat, user] of xs) left.appendChild(this._makeSeatBtn(mode, lobby, seat, user));
        for (const [seat, user] of ys) right.appendChild(this._makeSeatBtn(mode, lobby, seat, user));
        row.appendChild(left);
        if (lobby.status === 'live' || lobby.status === 'starting') {
          const mid = document.createElement('div');
          mid.className = 'team-mid';
          const spec = document.createElement('button');
          spec.type = 'button';
          spec.className = 'seat-btn spectate-btn';
          spec.textContent = 'Spectate';
          spec.addEventListener('click', async () => {
            try {
              this._setError('');
              this.selectedLobby = lobby.id;
              await this.onSpectate?.(mode, lobby.id);
            } catch (err) {
              this._setError(err.message || String(err));
            }
          });
          mid.appendChild(spec);
          row.appendChild(mid);
        }
        row.appendChild(right);
        card.appendChild(row);
      } else {
        const seats = document.createElement('div');
        seats.className = 'lobby-seats';
        for (const [seat, user] of seatEntries) {
          seats.appendChild(this._makeSeatBtn(mode, lobby, seat, user));
        }
        if (lobby.status === 'live' || lobby.status === 'starting') {
          const spec = document.createElement('button');
          spec.type = 'button';
          spec.className = 'seat-btn spectate-btn';
          spec.textContent = 'Spectate';
          spec.addEventListener('click', async () => {
            try {
              this._setError('');
              this.selectedLobby = lobby.id;
              await this.onSpectate?.(mode, lobby.id);
            } catch (err) {
              this._setError(err.message || String(err));
            }
          });
          seats.appendChild(spec);
        }
        card.appendChild(seats);
      }

      list.appendChild(card);
    }

    if (this.els.lobbyMeta) {
      if (!this.playAllowed) {
        this.els.lobbyMeta.textContent =
          'Spectate only — click Spectate on a live lobby. No HF login required.';
      } else if (mode === '1v1') {
        this.els.lobbyMeta.textContent =
          'Red vs blue — match starts when both sides have a player. Spectate is read-only.';
      } else if (mode === '4v4') {
        this.els.lobbyMeta.textContent =
          'Red (left) vs blue (right). Starts when full, or after 60s idle with ≥1 per side.';
      } else {
        this.els.lobbyMeta.textContent =
          'Sandbox starts when you join. Spectate watches a live lobby without taking a seat.';
      }
    }
  }
}
