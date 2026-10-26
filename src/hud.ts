/**
 * Recording HUD (plain script). Shows what the main window sends (current case, step, timer, result flash) and sends
 * button presses back; it holds no recording state of its own. Wrapped in a function so its names don't collide with
 * renderer.ts, which shares the global script scope at compile time.
 */
(() => {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let state: HudState | null = null;

  function format(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function elapsed(s: HudState): number {
    return s.activeMs + (s.paused ? 0 : Date.now() - s.segmentStart);
  }

  function render(): void {
    if (!state) return;
    const s = state;
    byId('timer').textContent = s.countdownUntil ? '00:00' : format(elapsed(s));
    byId('dot').classList.toggle('paused', s.paused);
    byId('label').textContent = s.label;
    byId('position').textContent = `${s.section} ${s.position}/${s.total}`;
    byId('cases').textContent = s.caseCount > 1 ? `Case ${s.caseIndex + 1}/${s.caseCount}` : '';

    // A guide ends with Done and has no Fail or Blocked, also while the countdown runs.
    byId<HTMLButtonElement>('pass').textContent = s.guide ? '✓ Done' : '✓ Pass';
    byId<HTMLButtonElement>('fail').hidden = s.guide;
    byId<HTMLButtonElement>('blocked').hidden = s.guide;

    const stepEl = byId('step');
    const remaining = s.countdownUntil ? Math.ceil((s.countdownUntil - Date.now()) / 1000) : 0;
    const counting = remaining > 0;
    document.body.classList.toggle('counting', counting);
    if (counting) {
      stepEl.classList.remove('flash');
      stepEl.style.background = '';
      stepEl.innerHTML = '';
      const big = document.createElement('span');
      big.className = 'count';
      big.textContent = String(remaining);
      stepEl.append(big, document.createTextNode('  Recording starts — switch to the browser'));
      byId('timer').textContent = '00:00';
      ['prev', 'next', 'pass', 'fail', 'blocked', 'pause'].forEach((id) => (byId<HTMLButtonElement>(id).disabled = true));
      byId<HTMLButtonElement>('stop').title = 'Cancel';
      return;
    }
    byId<HTMLButtonElement>('stop').title = 'Stop recording';

    const flashing = s.flash && Date.now() < s.flash.until;
    stepEl.classList.toggle('flash', !!flashing);
    stepEl.style.background = flashing && s.flash ? s.flash.color : '';
    if (flashing && s.flash) {
      stepEl.textContent = s.flash.text;
    } else {
      stepEl.innerHTML = '';
      const marker = document.createElement('span');
      // A guide shows its step number where a case shows the Given / When / Then keyword.
      marker.className = s.guide ? 'kw guide-number' : `kw kw-${s.keyword}`;
      marker.textContent = s.guide ? String(s.position) : s.keyword;
      stepEl.append(marker, document.createTextNode(` ${s.text}`));
    }

    byId<HTMLButtonElement>('prev').disabled = !s.canPrevious || s.finishing;
    byId<HTMLButtonElement>('next').disabled = !s.canNext || s.finishing;
    ['pass', 'fail', 'blocked'].forEach((id) => (byId<HTMLButtonElement>(id).disabled = s.paused || s.finishing));
    byId<HTMLButtonElement>('pause').textContent = s.paused ? '▶' : 'Ⅱ';
    byId<HTMLButtonElement>('pause').title = s.paused ? 'Resume' : 'Pause';
    byId<HTMLButtonElement>('pause').disabled = s.finishing;
  }

  window.recorder.onHudState((next) => {
    state = next;
    render();
  });

  // Timer and the end of a result flash need repainting without a new state.
  window.setInterval(render, 250);

  const actions: [string, HudAction][] = [
    ['prev', 'previous'], ['next', 'next'], ['pass', 'pass'], ['fail', 'fail'], ['blocked', 'blocked'],
    ['pause', 'pause'], ['stop', 'stop'], ['show-main', 'show-main'],
  ];
  actions.forEach(([id, action]) => byId<HTMLButtonElement>(id).addEventListener('click', () => window.recorder.hudAction(action)));
})();
