/* Optional one-shot presence check. Never blocks joining, answering or reconnecting. */
(() => {
  const room = new URLSearchParams(location.search).get('room');
  if (!room) return;
  let participant;
  let pending = false;
  const labels = {
    in_zone: 'Location within class area',
    outside: 'Outside class area — ask the teacher',
    needs_review: 'Attendance needs teacher review',
    confirmed: 'Attendance confirmed by teacher',
    rejected: 'Attendance not confirmed',
    not_required: 'Location check not required',
  };
  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:12px;margin:12px;border:1px solid #476583;border-radius:10px;color:inherit';
  panel.hidden = true;
  const button = document.createElement('button');
  button.textContent = 'Confirm attendance';
  const status = document.createElement('span');
  status.style.marginLeft = '12px';
  panel.append(button, status);
  document.body.prepend(panel);
  async function send(data) {
    const r = await fetch('/api/attendance/' + encodeURIComponent(room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: participant.nick, resume: participant.resume, ...data }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.detail || 'Attendance check unavailable');
    status.textContent = labels[body.status] || body.status;
  }
  button.onclick = async () => {
    if (pending || !participant) return;
    pending = true;
    button.disabled = true;
    status.textContent = 'Requesting location…';
    try {
      if (!window.isSecureContext || !navigator.geolocation) {
        await send({ unavailable: true });
        status.textContent = 'Location unavailable here. Ask the teacher to confirm attendance.';
      } else {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0,
          })
        );
        await send({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
      }
    } catch (e) {
      status.textContent =
        'Unable to verify location. You can continue the quiz and ask the teacher.';
      try {
        await send({ unavailable: true });
      } catch (_) {
        /* Independent of the game socket. */
      }
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
  window.addEventListener('algoclimb-joined', async (event) => {
    participant = event.detail;
    try {
      const r = await fetch('/api/attendance/' + encodeURIComponent(room));
      panel.hidden = !(await r.json()).enabled;
    } catch (_) {
      /* Attendance must not affect the game. */
    }
  });
})();
