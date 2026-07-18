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

  // 1. every view renders without throwing
  const views = ["program", "status", "discipline", "topics", "court", "upcoming", "milestones", "overview", "history", "guide"];
  views.forEach((v) => {
    try { window.setView(v); } catch (e) { errs.push(`setView(${v}) threw: ` + e.stack); }
  });

  // 2. Topics tab pulls its weight with a tab-count badge like Court/Upcoming
  window.setView("program");
  window.updateTabCounts();
  check("Topics tab-count badge exists", !!document.querySelector('#viewToggle button[data-view="topics"] .tab-count'));

  // 3. Topics view nests Program -> Package -> Topic (not a flat cross-package list)
  window.setView("topics");
  const progGroups = document.querySelectorAll("#topicsView>.altgroup");
  check("Topics view has program-level groups", progGroups.length > 0);
  check("Topics view has an Untagged subhead somewhere", !!Array.from(document.querySelectorAll("#topicsView .topic-subhead")).find((s) => s.textContent.indexOf("Untagged") !== -1));

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

  // 14. package quick-jump is populated and actually opens + flashes the target package
  const pkgJump = document.getElementById("pkgJump");
  check("package quick-jump has options beyond the placeholder", !!(pkgJump && pkgJump.querySelectorAll("option").length > 1));
  const firstPkgOpt = pkgJump && pkgJump.querySelector("optgroup option");
  if (firstPkgOpt) {
    pkgJump.value = firstPkgOpt.value;
    window.onPkgJumpChange();
    await new Promise((r) => setTimeout(r, 150));
    const flashedPkg = document.querySelector("#programView details.pkg.flash");
    check("package jump opens and flashes the target package", !!(flashedPkg && flashedPkg.open));
  }

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
