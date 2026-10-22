// Mirrors hasht-app's picker (src/bootstrap.ts there), minus the default
// server: that only steers links, and desktop doesn't route links yet.
const HOSTED_URL = "chat.hasht.net";
const HOSTED_NAME = "Hasht";

const $ = (id) => document.getElementById(id);
const serversSection = $("servers-section");
const serversEl = $("servers");
const addSection = $("add-section");
const addToggle = $("add-toggle");
const headline = $("headline");
const tagline = $("tagline");
const addHeading = $("add-heading");
const errorEl = $("error");

const urlInput = $("url");
const nameInput = $("name");
const hostedBtn = $("hosted-connect");
const selfhostedBtn = $("selfhosted-connect");

// Only one choice card is expanded at a time.
function selectCard(card) {
  for (const c of document.querySelectorAll(".card")) c.classList.toggle("selected", c === card);
}
for (const card of document.querySelectorAll(".card")) {
  card.addEventListener("click", (event) => {
    if (event.target.closest(".card-body")) return; // don't collapse while typing
    selectCard(card);
    if (card.dataset.choice === "selfhosted") urlInput.focus();
  });
}

// With servers saved, adding one is behind the "+" on "Your servers".
let adding = false;
function setAdding(open) {
  adding = open;
  addToggle.setAttribute("aria-expanded", String(open));
  addToggle.setAttribute("aria-label", open ? "Close" : "Add a server");
  addToggle.title = open ? "Close" : "Add a server";
  if (!serversSection.hidden) addSection.hidden = !open;
  if (!open) selectCard(null);
}
addToggle.onclick = () => setAdding(!adding);

async function withBusy(btn, fn) {
  errorEl.textContent = "";
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    errorEl.textContent = err?.message ?? "Couldn't reach that server.";
  } finally {
    btn.disabled = false;
  }
}

hostedBtn.onclick = () =>
  withBusy(hostedBtn, async () => {
    await window.picker.addServer(HOSTED_URL, HOSTED_NAME);
    setAdding(false);
  });

selfhostedBtn.onclick = () =>
  withBusy(selfhostedBtn, async () => {
    const url = urlInput.value.trim();
    if (!url) throw new Error("Enter your server's address.");
    await window.picker.addServer(url, nameInput.value.trim());
    urlInput.value = "";
    nameInput.value = "";
    setAdding(false);
  });

function h(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = h("button", className, text);
  node.type = "button";
  node.onclick = onClick;
  return node;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// The row whose actions are showing; one at a time.
let openRow = null;

function renderServer(s) {
  const row = h("div", "server");
  const account = s.username ? `@${s.username}` : "Not signed in";

  const meta = h("button", "meta");
  meta.type = "button";
  meta.title = "Switch to this server";
  meta.append(h("div", "name", s.name));
  const sub = h("div", "sub");
  sub.append(h("span", s.username ? "account" : "account signed-out", account), h("span", "host", hostOf(s.url)));
  meta.append(sub);
  meta.setAttribute(
    "aria-label",
    `${s.name}, ${s.displayName ? `${s.displayName}, ` : ""}${account}, ${hostOf(s.url)}`,
  );
  meta.onclick = () => window.picker.connectExisting(s.id);

  const more = button("icon-btn more", "", () => {
    openRow = openRow === s.id ? null : s.id;
    refresh();
  });
  more.setAttribute("aria-label", `Options for ${s.name}`);
  more.title = "Options";
  more.setAttribute("aria-expanded", String(openRow === s.id));
  more.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

  const head = h("div", "server-head");
  head.append(meta, more);
  row.append(head);
  if (openRow === s.id) row.append(renderActions(s));
  return row;
}

function renderActions(s) {
  const actions = h("div", "actions");
  const close = () => {
    openRow = null;
    refresh();
  };

  const showMain = () => {
    actions.replaceChildren(
      button("chip", "Rename", showRename),
      button("chip danger", "Remove", showRemove),
    );
  };

  const showRename = () => {
    const form = h("form", "rename");
    const input = h("input", "");
    input.value = s.name;
    input.setAttribute("aria-label", "Name");
    const save = h("button", "chip primary-chip", "Save");
    save.type = "submit";
    form.append(input, save, button("chip", "Cancel", showMain));
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      await window.picker.renameServer(s.id, input.value);
      close();
    };
    actions.replaceChildren(form);
    input.focus();
    input.select();
  };

  const showRemove = () => {
    actions.replaceChildren(
      h("p", "confirm", `Remove ${s.name} from this computer? You'll need to sign in again to add it back.`),
      button("chip danger-fill", "Remove", async () => {
        await window.picker.removeServer(s.id);
        close();
      }),
      button("chip", "Cancel", showMain),
    );
  };

  showMain();
  return actions;
}

async function refresh() {
  const servers = await window.picker.listServers();
  const hasServers = servers.length > 0;

  serversSection.hidden = !hasServers;
  // First run shows the connect cards straight away; after that they wait
  // behind "+".
  addSection.hidden = hasServers && !adding;
  headline.textContent = hasServers ? "Hasht" : "Welcome to Hasht";
  tagline.textContent = hasServers ? "Pick a server to open." : "Choose how you want to connect.";
  addHeading.textContent = hasServers ? "Add a server" : "Connect";

  // On first run, nudge toward the hosted option.
  if (!hasServers && !document.querySelector(".card.selected")) {
    $("card-hosted").classList.add("selected");
  }

  if (openRow && !servers.some((s) => s.id === openRow)) openRow = null;
  serversEl.replaceChildren(...servers.map(renderServer));
}

// A server window may have reported a sign-in or sign-out since this was drawn.
window.addEventListener("focus", () => refresh());

refresh();
