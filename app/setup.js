// The first-run setup window (2026-11-14, plan: "a novice can figure it out"). Every step checks
// itself every few seconds and turns green; nothing to type. Finish is always allowed: the overlay
// works without a 24spells save, and the tray's "Setup and settings..." reopens this window.
const $ = (id) => document.getElementById(id);
let busy = false;

function mark(li, state, text) {
  li.dataset.state = state; // ok | todo | wait | off
  li.querySelector('.say').textContent = text;
}

function render(s) {
  if (!s) return;
  $('version').textContent = s.version;

  // 1. Arena.
  if (s.arenaInstalled) mark($('s-arena'), 'ok', s.arenaRunning ? 'Found, and running.' : 'Found on this PC.');
  else mark($('s-arena'), 'todo', "Not found yet. Install MTG Arena and open it once; this turns green on its own.");

  // 2. Detailed Logs.
  const how = $('s-logs').querySelector('.how');
  if (s.detailedLogs === true) {
    mark($('s-logs'), 'ok', 'On. The overlay can read your drafts.');
    how.hidden = true;
  } else if (s.detailedLogs === false) {
    mark($('s-logs'), 'todo', 'Off. One setting in Arena:');
    how.hidden = false;
  } else {
    mark($('s-logs'), 'wait', s.arenaLog ? "Can't tell yet: restart Arena once and this updates." : 'Open Arena once so the overlay can check.');
    how.hidden = false;
  }

  // 3. 24spells.
  const connect = $('connect');
  if (s.connected) {
    mark($('s-connect'), 'ok', `Connected as ${s.connected}. Your drafts and games show up in your Record.`);
    connect.hidden = true;
  } else if (s.connecting) {
    mark($('s-connect'), 'wait', 'Finish on 24spells: sign in to your save there (or make one), and this turns green.');
    connect.hidden = false;
    connect.textContent = 'Open 24spells again';
  } else {
    mark($('s-connect'), 'off', 'See your record, runs and game replays on any device. Free, no email.');
    connect.hidden = false;
    connect.textContent = 'Connect to 24spells';
  }

  // Your data.
  for (const key of ['share', 'open17Lands', 'startWithWindows']) $(key).checked = Boolean(s[key]);
  const seventeen = $('seventeen');
  if (!s.client17) {
    seventeen.innerHTML = '';
    seventeen.append("17Lands' app isn't installed, so there's nothing to open. ");
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = 'Get it';
    b.addEventListener('click', () => window.setup.open('seventeen'));
    seventeen.append(b);
  } else {
    seventeen.textContent = "Opens 17Lands' own app with Arena. Optional.";
  }

  const ready = s.arenaInstalled && s.detailedLogs === true;
  $('ready').textContent = ready ? "You're ready. Open a draft in Arena and the stats appear on the cards." : 'You can finish now and come back from the tray icon any time.';
  $('ready').dataset.ready = ready ? '1' : '0';
}

async function refresh() {
  if (busy) return;
  render(await window.setup.state());
}

for (const key of ['share', 'open17Lands', 'startWithWindows']) {
  $(key).addEventListener('change', async (e) => {
    busy = true;
    try {
      render(await window.setup.set(key, e.currentTarget.checked));
    } finally {
      busy = false;
    }
  });
}
$('connect').addEventListener('click', async () => render(await window.setup.connect()));
$('done').addEventListener('click', () => window.setup.done());
for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => window.setup.open(b.dataset.open));
window.setup.onChanged(refresh);

void refresh();
setInterval(refresh, 3000);
