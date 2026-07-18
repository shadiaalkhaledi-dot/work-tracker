// Pre-deploy smoke test for index.html.
//
// Loads the real index.html + the local plain data.json into jsdom, boots the
// app exactly like a browser would (via boot(), bypassing the encrypted-gate
// fetch), exercises every view/tab, and pokes at the interactive bits that
// are easy to silently break with a later edit: the done-toggle/badge swap,
// the court/topic inline editors, the Focus-panel <details> toggle, the
// clear-filters control, the History timeline toggle, and the inline
// capture form (subtask/blocker/note — replaced window.prompt()).
//
// Run before every deploy:
//   npm install jsdom --no-save   (once, if not already present)
//   node smoke_test.js
//
// Note: `npm install` here writes hundreds of files under node_modules/,
// and this folder is synced through Cowork's connected-folder bridge, which
// has been unreliable for large multi-file operations (partial copies,
// silent drops — the same landmine documented in the skill for big vault
// writes). Prefer running this from a scratch/temp copy of the pipeline
// folder (copy index.html + data.json out, npm install there, run, copy
// index.html back once clean) rather than installing node_modules directly
// into this synced folder.
//
// Exits 1 on any unexpected error or failed assertion, 0 if everything's
// clean. "fetch is not defined" from the real bootstrap's data.enc.json
// fetch is expected here (jsdom has no fetch) and is filtered out — it
// never fires in an actual browser.

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, "index.html"), "utf-8");
const data = JSON.parse(fs.readFileSync(path.join(DIR, "data.json"), "utf-8"));

const vc = new (require("jsdom").VirtualConsole)();
let errs = [];
const ignorable = (m) => String(m).indexOf("fetch is not defined") !== -1;
vc.on("jsdomError", (e) => { if (!ignorable(e.message)) errs.push("jsdomError: " + e.message); });

let failures = [];
function check(label, cond) {
  if (!cond) failures.push(label);
}

(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", virtualConsole: vc, url: "http://localhost/" });
  const { window } = dom;
  const document = window.document;
  window.onerror = (m) => { if (!ignorable(m)) errs.push("window.onerror: " + m); };
  // jsdom has no scrollIntoView implementation at all (real browsers all have it) —
  // polyfill so jumpToPackage()/focusJumpTo() can be exercised without a false failure.
  window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || function () {};

  // let DOMContentLoaded's fetch() attempt fail quietly (no fetch in jsdom)
  await new Promise((r) => setTimeout(r, 200));

  try {
    window.boot(data);
  } catch (e) {
    errs.push("boot() threw: " + e.stack);
  }

  // 1. every view renders without throwing — including the new top-level names
  // and the legacy aliases (old saved UI states may still carry them)
  const views = ["board", "program", "status", "discipline", "topics", "court", "upcoming", "progress", "milestones", "overview", "history", "guide"];
  views.forEach((v) => {
    try { window.setView(v); } catch (e) { errs.push(`setView(${v}) threw: ` + e.stack); }
  });

  // 2. Threads group-by chip carries the attention count badge
  window.setView("program");
  window.updateTabCounts();
  check("Threads count badge exists on the group-by chip", !!document.querySelector('#boardModeToggle button[data-mode="topics"] .tab-count'));
  check("board-mode toggle visible on Board view", document.getElementById("boardModeToggle").style.display !== "none");

  // 3. Threads view cuts ACROSS packages: thread cards with story-line summaries
  window.setView("topics");
  const threadEls = document.querySelectorAll("#topicsView details.thread");
  check("Threads view has thread cards", threadEls.length > 0);
  check("thread summary carries a state word", !!document.querySelector("#topicsView .th-state"));
  const openUntagged = data.items.filter((i) => i.status !== "completed" && !i.topic).length;
  if (openUntagged > 0) check("threads mention untagged items in a footnote", !!Array.from(document.querySelectorAll("#topicsView p.empty")).find((s) => s.textContent.indexOf("without a topic") !== -1));
  const rfiThread = Array.from(threadEls).find((t) => t.querySelector(".item[data-state]"));
  check("at least one thread contains an RFI item", !!rfiThread);
  check("board-mode toggle hides on non-board views", (window.setView("court"), document.getElementById("boardModeToggle").style.display === "none"));

  // 3b. Progress = Overview + Milestones merged
  window.setView("progress");
  check("Progress shows the overview rollup", document.getElementById("overviewView").children.length > 0);
  check("Progress shows the milestones register", document.getElementById("milestonesView").children.length > 0);
  check("legacy setView(milestones) lands on Progress", (window.setView("milestones"), document.querySelector('#viewToggle button[data-view="progress"]').classList.contains("active")));

  // 3c. radar: quiet-too-long strip builds and groups
  window.setView("program");
  window.buildRadarPanel();
  const radar = document.getElementById("radarPanel");
  check("radar panel exists", !!radar);
  if (radar.style.display !== "none") {
    check("radar has a summary line", document.getElementById("radarSummary").textContent.length > 5);
    check("radar rows have age chips", !!radar.querySelector(".radar-age"));
    check("radar rows grouped under bucket labels", !!radar.querySelector(".radar-bucket"));
  }

  // 3d. delta: since-you-last-looked builds when a previous visit day exists
  window.localStorage.setItem("wt-last-visit", JSON.stringify({prev: "2026-07-10", current: "2026-07-10"}));
  window.buildDeltaStrip();
  const delta = document.getElementById("deltaStrip");
  check("delta strip renders rows for a returning visitor", delta.style.display !== "none" && !!delta.querySelector(".delta-row"));
  check("delta rows carry new/moved/closed tags", !!delta.querySelector(".delta-tag"));

  // 4. card structure: badges in their own row, title in its own block
  window.setView("program");
  const sample = document.querySelector("#programView .item.blocking") || document.querySelector("#programView .item");
  check("sample item has .item-badges", !!(sample && sample.querySelector(":scope>.item-badges")));
  check("sample item has .item-title with text", !!(sample && sample.querySelector(":scope>.item-title").textContent.trim().length));

  // 5. done-toggle / badge-swap round-trip still works with the new card structure
  const blockingItem = document.querySelector("#programView .item.blocking");
  if (blockingItem) {
    const cb = blockingItem.querySelector(".done-toggle");
    const before = blockingItem.querySelector(":scope>.item-badges .badge");
    check("blocking item shows a BLOCKING badge before check", !!(before && before.textContent === "BLOCKING"));
    cb.checked = true; cb.dispatchEvent(new window.Event("change"));
    check("badge swaps to C when marked complete", !!blockingItem.querySelector(":scope>.item-badges .badge.c"));
    cb.checked = false; cb.dispatchEvent(new window.Event("change"));
    const afterUncheck = blockingItem.querySelector(":scope>.item-badges .badge");
    check("badge restores to BLOCKING when unchecked", !!(afterUncheck && afterUncheck.textContent === "BLOCKING"));
  }

  // 6. clear-filters control appears only when a filter is active, and actually clears
  document.getElementById("myCourtBtn").click();
  window.applySearchFilter();
  check("clear-filters button appears when a filter is active", !!document.querySelector("#viewHeading .filter-clear"));
  const clearBtn = document.querySelector("#viewHeading .filter-clear");
  if (clearBtn) clearBtn.click();
  check("My Court turns off after clear-filters", !document.getElementById("myCourtBtn").classList.contains("active"));

  // 7. Focus panel is a collapsible <details>, state persists via saveUiState
  const focusPanel = document.getElementById("focusPanel");
  check("Focus panel is a <details>", focusPanel.tagName === "DETAILS");
  focusPanel.open = false;
  window.saveUiState();
  check("focusOpen state persists as false", JSON.parse(window.localStorage.getItem("wt-ui-state")).focusOpen === false);

  // 8. topic pill opens the inline cascade editor with existing topics listed
  window.setView("program");
  const taggedItem = Array.from(document.querySelectorAll("#programView .item")).find((it) => it.querySelector(".topic-pill:not(.topic-pill-empty)"));
  if (taggedItem) {
    taggedItem.querySelector(".topic-pill").click();
    const sel = taggedItem.querySelector(".court-cascade select");
    check("topic editor opens with existing topics listed", !!(sel && sel.options.length > 1));
  }

  // 9. History (timeline) toggle has a real button affordance and actually opens
  window.setView("program");
  const tlBtn = document.querySelector("#programView .tl-toggle");
  if (tlBtn) {
    check("History toggle has a chevron span", !!tlBtn.querySelector(".tl-chev"));
    tlBtn.click();
    check("History toggle gets tl-open class on click", tlBtn.classList.contains("tl-open"));
    check("timeline actually opens", tlBtn.nextElementSibling.classList.contains("tl-open"));
  }

  // 10. inline capture form replaces window.prompt() for subtask/blocker/note
  const anyItem = document.querySelector("#programView .item");
  const subtaskBtn = Array.from(anyItem.querySelectorAll(".item-actions button")).find((b) => b.textContent.indexOf("subtask") !== -1);
  if (subtaskBtn) {
    subtaskBtn.click();
    const capture = anyItem.querySelector(".inline-capture");
    check("inline capture form appears on '+ subtask' click", !!capture);
    if (capture) {
      capture.querySelector("textarea").value = "__smoke_test_subtask__";
      capture.querySelector(".pedit-row button:not(.pcancel)").click();
    }
    const queue = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
    check("inline capture queues to localStorage on save", queue.some((p) => p.text === "__smoke_test_subtask__"));
    check("inline capture form removes itself after save", !document.querySelector(".inline-capture"));
  }

  // 11. accessibility spot-check on the checkboxes/inputs touched daily
  const doneCb = document.querySelector("#programView .item .done-toggle");
  check("done-toggle has an aria-label", !!(doneCb && doneCb.hasAttribute("aria-label")));
  check("search box has an aria-label", !!document.getElementById("searchBox").getAttribute("aria-label"));

  // 12. voice/session-notes render as a list when items[] is present
  window.setView("program");
  check("voice entries with items[] render as <ul> lists", document.querySelectorAll("#voiceBox ul.voice-list").length > 0);

  // 13. data-freshness chip reflects meta.generated
  const freshChip = document.getElementById("dataFreshness");
  check("freshness chip has text", !!(freshChip && freshChip.textContent.trim().length));

  // 14. command palette: finds packages/people/items; package pick opens + flashes
  window.setView("program");
  const sb = document.getElementById("searchBox");
  sb.value = "Envelope";
  sb.dispatchEvent(new window.Event("input"));
  const pkgRow = document.querySelector("#palette .pal-package");
  check("palette finds a package for 'Envelope'", !!pkgRow);
  if (pkgRow) {
    pkgRow.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const flashedPkg = document.querySelector("#programView details.pkg.flash");
    check("palette package pick opens and flashes the target", !!(flashedPkg && flashedPkg.open));
  }
  sb.value = "knuckle";
  sb.dispatchEvent(new window.Event("input"));
  check("palette finds a thread for 'knuckle'", !!document.querySelector("#palette .pal-thread"));
  const itemRow = document.querySelector("#palette .pal-item");
  check("palette finds items for 'knuckle'", !!itemRow);
  if (itemRow) {
    itemRow.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    check("palette item pick opens the drawer", document.getElementById("drawerOverlay").style.display !== "none");
    window.closeDrawer();
  }
  sb.value = "";
  sb.dispatchEvent(new window.Event("input"));

  // 15. pending-capture rows: Edit/Remove actually persist to localStorage (this is the ONLY
  // capture path in real use — API_URL stays unset, so payload.row is always undefined; the
  // Edit button used to be gated on payload.row and silently never appeared for real captures)
  window.setView("program");
  const noteBtn = Array.from(document.querySelectorAll("#programView .item .item-actions button")).find((b) => b.textContent.indexOf("note") !== -1);
  if (noteBtn) {
    const card = noteBtn.closest(".item");
    noteBtn.click();
    card.querySelector(".inline-capture textarea").value = "__smoke_test_original__";
    card.querySelector(".inline-capture .pedit-row button:not(.pcancel)").click();
    const row = Array.from(document.querySelectorAll("#pendingList .pending-row")).find((r) => r.textContent.indexOf("__smoke_test_original__") !== -1);
    check("pending row rendered for the new local capture", !!row);
    if (row) {
      const editBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Edit");
      check("Edit button appears for a local (non-server) capture", !!editBtn);
      if (editBtn) {
        editBtn.click();
        const textInput = Array.from(row.querySelectorAll("input[type=text]")).pop();
        textInput.value = "__smoke_test_edited__";
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Save").click();
        const q1 = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
        check("editing a local capture persists to localStorage", q1.some((p) => p.text === "__smoke_test_edited__"));
        const removeBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Remove");
        check("Remove button exists on a pending row", !!removeBtn);
        if (removeBtn) {
          window.confirm = () => true;
          removeBtn.click();
          const q2 = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
          check("Remove actually deletes the capture from localStorage", !q2.some((p) => p.text === "__smoke_test_edited__"));
        }
      }
    }
  }

  // 16. briefing block wraps the four attention widgets into one card
  const briefing = document.getElementById("briefing");
  check("briefing block exists", !!briefing);
  ["todayFocus","focusPanel","deltaStrip","radarPanel"].forEach((id) => {
    check("briefing contains #"+id, !!briefing.querySelector("#"+id));
  });

  // 17. context drawer: opens from a radar row, shows card + thread + merged timeline
  window.buildRadarPanel();
  const radarRow = document.querySelector("#radarList .radar-row");
  if (radarRow) {
    radarRow.click();
    const overlay = document.getElementById("drawerOverlay");
    check("drawer opens from a radar row", overlay.style.display !== "none");
    check("drawer shows the full card", !!document.querySelector("#drawerBody .item.drawer-card"));
    const openedId = document.getElementById("drawer").getAttribute("data-item");
    const openedItem = data.items.find((i) => i.id === openedId);
    if (openedItem && openedItem.topic) {
      check("drawer shows merged thread timeline", !!document.querySelector("#drawerBody .ev-row"));
    }
    // sibling click pushes the back stack
    const sib = document.querySelector("#drawerBody .drawer-sib");
    if (sib) {
      sib.click();
      check("back button appears after drilling into a sibling", document.getElementById("drawerBack").style.display !== "none");
      window.drawerBack();
    }
    // Esc closes
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check("Esc closes the drawer", overlay.style.display === "none");
  } else {
    check("radar row exists to open drawer from", false);
  }

  // 18. clicking a card TITLE opens the drawer — including on clones in Threads view
  window.setView("topics");
  const cloneTitle = document.querySelector("#topicsView .item .item-title");
  if (cloneTitle) {
    cloneTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check("title click on a thread clone opens drawer", document.getElementById("drawerOverlay").style.display !== "none");
    window.closeDrawer();
  }

  // 19. nudge button: records a chase and resets the quiet clock
  window.setView("program");
  window.buildRadarPanel();
  const nudge = document.querySelector("#radarList .nudge-btn:not(.chase-btn)");
  if (nudge) {
    const before = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]").length;
    nudge.click();
    const q = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
    check("nudge queues a chase capture", q.length === before + 1 && q[q.length-1].text.indexOf("nudged") === 0);
    check("toast appears where the action happened", !!document.querySelector("#toastWrap .toast"));
  } else {
    check("nudge button present on a waiting radar row", false);
  }

  // 20. unified history: filters + day-grouped stream + drawer link
  window.setView("history");
  check("history has filter selects", document.querySelectorAll("#historyView .hist-filters select").length === 3);
  check("history stream renders event rows", document.querySelectorAll("#historyView .ev-row").length > 10);
  check("history stream has day headers", document.querySelectorAll("#historyView .ev-day").length > 3);
  const topicSel = document.querySelectorAll("#historyView .hist-filters select")[2];
  const allRows = document.querySelectorAll("#historyView .ev-row").length;
  if (topicSel.options.length > 1) {
    topicSel.value = topicSel.options[1].value;
    topicSel.dispatchEvent(new window.Event("change"));
    const filtered = document.querySelectorAll("#historyView .ev-row").length;
    check("thread filter narrows the stream", filtered > 0 && filtered < allRows);
    const evRow = document.querySelector("#historyView .ev-row[style*=pointer], #historyView .ev-row");
    if (evRow) { evRow.click(); check("history event opens the drawer", document.getElementById("drawerOverlay").style.display !== "none"); window.closeDrawer(); }
  }

  // 21. chase draft: copy button exists on waiting radar rows; text is substantive
  window.setView("program");
  window.buildRadarPanel();
  const chaseBtn = document.querySelector("#radarList .chase-btn");
  check("copy-chase button on radar rows", !!chaseBtn);
  const waitingItem = data.items.find((i) => i.status !== "completed" && i.court && String(i.court).indexOf("You") === -1);
  if (waitingItem) {
    const txt = window.chaseTextFor(waitingItem);
    check("chase text greets and references the item", txt.indexOf("Hi ") === 0 && txt.indexOf(waitingItem.title.slice(0, 20)) !== -1);
  }

  // 22. meeting prep: selector renders, picking a person builds the brief + copy agenda
  window.setView("court");
  const prepSel = document.querySelector(".prep-box select");
  check("prep selector exists in Court view", !!prepSel);
  const personOpt = prepSel && Array.from(prepSel.querySelectorAll("optgroup[label=People] option"))[0];
  if (personOpt) {
    prepSel.value = personOpt.value;
    prepSel.dispatchEvent(new window.Event("change"));
    const box = document.querySelector(".prep-box");
    check("prep brief shows They-owe-you section", box.textContent.indexOf("They owe you") !== -1);
    check("prep brief has a copy-agenda button", !!Array.from(box.querySelectorAll("button")).find((b) => b.textContent.indexOf("copy agenda") !== -1));
    window.prepChoice = ""; window.setView("court");
  }

  // 23. week summary text contains its five sections
  const wtxt = window.weekSummaryText();
  ["Closed", "Moved", "Still blocking", "Coming up"].forEach((sec) => {
    check("week summary has section: " + sec, wtxt.indexOf(sec) !== -1);
  });
  check("copy-week-summary button in History", (window.setView("history"), !!Array.from(document.querySelectorAll("#historyView .hist-filters button")).find((b) => b.textContent.indexOf("week summary") !== -1)));

  // 24. milestone risk flags render when blocking work sits behind a near date (data-dependent)
  const riskChips = document.querySelectorAll(".ms-chip.risk").length;
  console.log("  (info) at-risk submission chips right now:", riskChips);

  // 25. capture box is a slim collapsible bar whose summary counts the queue
  const capBox = document.getElementById("captureBox");
  check("capture box is a <details>", !!capBox && capBox.tagName === "DETAILS");
  check("capture summary reports pending count", document.getElementById("capSumNote").textContent.indexOf("pending") !== -1);

  // 26. threads are grouped by program (with cross-program group when present)
  window.setView("topics");
  check("threads view has program group headers", document.querySelectorAll("#topicsView .altgroup-head").length > 0);

  // 27. stats live inside the briefing now
  check("stats row folded into briefing", !!document.querySelector("#briefing .stats"));

  // 28. My Day: pin from a card, row appears, reorder works, done syncs, export carries the plan
  window.setView("program");
  const pins = document.querySelectorAll("#programView .pin-btn");
  check("pin buttons on cards", pins.length > 10);
  const cardA = document.querySelector("#programView .item:not(.completed):not(.watch)");
  const cardB = Array.from(document.querySelectorAll("#programView .item:not(.completed):not(.watch)")).find((c) => c !== cardA);
  cardA.querySelector(".pin-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  cardB.querySelector(".pin-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  let mdRows = document.querySelectorAll("#myDaySec .my-day-row");
  check("My Day shows the two picked rows", mdRows.length === 2);
  check("pin button reflects on-state", cardA.querySelector(".pin-btn").classList.contains("pin-on"));
  const firstTitle = mdRows[0].querySelector(".md-title").textContent;
  mdRows[1].querySelector(".md-ctrls button").dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // move #2 up
  mdRows = document.querySelectorAll("#myDaySec .my-day-row");
  check("reorder moves the row up", mdRows[0].querySelector(".md-title").textContent !== firstTitle);
  // done from My Day syncs to the board's done-toggle + capture queue
  const qBefore = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]").length;
  const mdCb = document.querySelectorAll("#myDaySec .my-day-row input[type=checkbox]")[0];
  mdCb.checked = true; mdCb.dispatchEvent(new window.Event("change"));
  const qAfter = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
  check("My Day done queues the completion", qAfter.length === qBefore + 1 && qAfter[qAfter.length-1].type === "complete");
  check("My Day shows progress count", document.querySelector("#myDaySec .my-day-prog").textContent.indexOf("1/2") !== -1);
  // export text carries the ordered plan
  let copied = "";
  window.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
  window.exportCaptures();
  await new Promise((r) => setTimeout(r, 50));
  check("check-in export includes My day plan", copied.indexOf("My day plan") !== -1 && copied.indexOf("1.") !== -1);

  // 29. honest due stats: no 📅 dates in data → overdue shows an em-dash, sprint counts horizons
  check("overdue stat honest when no due dates exist", document.getElementById("statOverdue").textContent === "\u2014");
  check("sprint stat counts horizon-anchored items", parseInt(document.getElementById("statSprintEnd").textContent, 10) >= 1);

  // 30. stats are clickable: blocking stat jumps to the status-grouped board
  document.getElementById("statBlocking").closest(".stat").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("blocking stat opens status view", document.getElementById("statusView").style.display !== "none");

  // 31. clone action buttons work now: '+ subtask' on a Threads-view clone opens inline capture
  window.setView("topics");
  const cloneBtn = Array.from(document.querySelectorAll("#topicsView .item-actions button")).find((b) => b.textContent === "+ subtask");
  if (cloneBtn) {
    cloneBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check("clone '+ subtask' opens an inline capture form", !!document.querySelector("#topicsView .inline-capture"));
    const cancel = document.querySelector("#topicsView .inline-capture .pcancel");
    if (cancel) cancel.click();
  } else {
    check("found a clone '+ subtask' button in Threads view", false);
  }
  window.setView("program");
  // cleanup my-day state
  window.saveMyDay({date:null, ids:[]});

  // 32. RFI register on Progress: table, aging sort, row opens drawer
  window.setView("progress");
  const regRows = document.querySelectorAll("#rfiRegView .rfi-reg-row");
  check("RFI register renders rows", regRows.length >= 4);
  const openRows = Array.from(regRows).filter((r) => !r.classList.contains("rr-closed"));
  check("open RFIs sort before closed", regRows.length && !regRows[0].classList.contains("rr-closed"));
  if (regRows[0]) {
    regRows[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check("register row opens the drawer", document.getElementById("drawerOverlay").style.display !== "none");
    window.closeDrawer();
  }

  // 33. set-due: popover queues a due payload, board picks it up via overlay
  window.setView("program");
  const dueBtn = document.querySelector("#programView .item:not(.completed) .due-btn");
  check("set-due button on cards", !!dueBtn);
  if (dueBtn) {
    const card = dueBtn.closest(".item");
    const cardTitle = card.querySelector(".item-title").textContent;
    dueBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const pop = document.querySelector(".due-pop");
    check("due popover opens", !!pop);
    pop.querySelector("input[type=date]").value = "2030-01-02";
    Array.from(pop.querySelectorAll("button")).find((b) => b.textContent === "Queue it").click();
    const qDue = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
    check("due payload queued", qDue.some((p) => p.type === "due" && p.text === "2030-01-02"));
    const cardAgain = Array.from(document.querySelectorAll("#programView .item")).find((c) => c.querySelector(".item-title") && c.querySelector(".item-title").textContent === cardTitle);
    check("overlay applies the pending due to the board", !!(cardAgain && cardAgain.getAttribute("data-due") === "2030-01-02"));
  }

  // 34. email-the-queue exists and export text still builds
  check("Email queue button exists", !!Array.from(document.querySelectorAll("#captureBox button")).find((b) => b.textContent === "Email queue"));
  const exp = window.buildExportText();
  check("export text builds with queue content", !!exp && exp.indexOf("Work Tracker captures") === 0);

  // 35. toast undo: marking done offers undo; undo unchecks AND removes the phantom capture
  const undoCard = Array.from(document.querySelectorAll("#programView .item:not(.completed):not(.done-pending)")).find((c) => c.querySelector(".done-toggle"));
  if (undoCard) {
    const cb = undoCard.querySelector(".done-toggle");
    const title = undoCard.querySelector(".item-title").textContent.slice(0, 50);
    cb.checked = true; cb.dispatchEvent(new window.Event("change"));
    const undoBtn = Array.from(document.querySelectorAll("#toastWrap .toast-act")).pop();
    check("done toast offers undo", !!undoBtn);
    if (undoBtn) {
      undoBtn.click();
      check("undo unchecks the item", !cb.checked && !undoCard.classList.contains("done-pending"));
      const qU = JSON.parse(window.localStorage.getItem("wt-capture-queue") || "[]");
      check("undo removes the queued completion", !qU.some((p) => p.type === "complete" && p.text.indexOf(title) === 0));
    }
  }

  if (errs.length) {
    console.log(`${errs.length} unexpected error(s):`);
    errs.forEach((e) => console.log(" - " + e));
  }
  if (failures.length) {
    console.log(`${failures.length} FAILED check(s):`);
    failures.forEach((f) => console.log(" - " + f));
  }
  if (!errs.length && !failures.length) {
    console.log("All checks passed — clean to deploy.");
  }
  process.exit(errs.length || failures.length ? 1 : 0);
})();
