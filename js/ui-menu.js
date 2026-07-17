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
  }) {
    this.root = root;
    this.onSandbox = onSandbox;
    this.onOpenMode = onOpenMode;
    this.onBack = onBack;
    this.onClaim = onClaim;
    this.onLeaveSeat = onLeaveSeat;
    this.onEnterMatch = onEnterMatch;
    this.screen = 'start'; // start | lobby
    this.mode = null;
    this.username = null;
    this.spaceUrl = null;
    this.authError = null;
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

  setIdentity({ username, spaceUrl, authError }) {
    this.username = username;
    this.spaceUrl = spaceUrl;
    this.authError = authError;
    if (this.els.userLabel) {
      this.els.userLabel.textContent = username
        ? `Signed in as ${username}`
        : (authError || 'Not signed in — set HF_TOKEN in .env.local');
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
    if (this.els.start) this.els.start.hidden = false;
    if (this.els.lobby) this.els.lobby.hidden = true;
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

      const seats = document.createElement('div');
      seats.className = 'lobby-seats';

      const seatEntries = Object.entries(lobby.seats || {});
      for (const [seat, user] of seatEntries) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seat-btn' + (user ? ' filled' : '');
        btn.disabled = !!user || lobby.status === 'live';
        btn.textContent = user ? `${seat}: ${user}` : `Join ${seat}`;
        btn.addEventListener('click', async () => {
          try {
            this._setError('');
            await this.onClaim?.(mode, lobby.id, seat);
            this.selectedLobby = lobby.id;
          } catch (err) {
            this._setError(err.message || String(err));
          }
        });
        seats.appendChild(btn);
      }
      card.appendChild(seats);
      list.appendChild(card);
    }

    if (this.els.lobbyMeta) {
      this.els.lobbyMeta.textContent =
        mode === '1v1'
          ? 'Match starts when both A and B are filled.'
          : mode === '4v4'
            ? 'Starts when full, or after 60s idle with ≥1 player per side.'
            : 'Sandbox starts as soon as you join a lobby.';
    }
  }
}
