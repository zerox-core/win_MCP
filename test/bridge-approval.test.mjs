import assert from "node:assert/strict";
import test from "node:test";

const { renderApproval, resolveChoice, createTerminalApproval } = await import(
  "../dist/bridge/approval.js"
);

/** Mirrors the shape win_mcp returns for a write that needs confirmation. */
function approvalRequest(overrides = {}) {
  return {
    requestState: "state-token",
    inputRequests: {
      approval: {
        method: "elicitation/create",
        params: {
          message: "Authorize write_file?\nTarget: C:\\work\\a.txt\nScope: exact path",
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                title: "Authorization",
                enum: ["allow_once", "allow_session", "allow_permanent", "deny"],
              },
            },
            required: ["decision"],
          },
        },
      },
      ...overrides,
    },
  };
}

function collector() {
  const chunks = [];
  return {
    stream: { write: (chunk) => { chunks.push(String(chunk)); return true; } },
    text: () => chunks.join(""),
  };
}

test("renderApproval surfaces the target and numbered choices", () => {
  const text = renderApproval(approvalRequest());
  assert.match(text, /approval required/);
  // The server's own message must survive: it names the target and risk.
  assert.match(text, /Target: C:\\work\\a\.txt/);
  assert.match(text, /\[1\] Allow once/);
  assert.match(text, /\[2\] Allow for this session/);
  assert.match(text, /\[4\] Deny/);
});

test("renderApproval falls back when the request is malformed", () => {
  const text = renderApproval({ requestState: "x", inputRequests: {} });
  assert.match(text, /approval required/);
  assert.match(text, /\[1\] Allow once/);
});

test("resolveChoice accepts index, exact name, and y/n", () => {
  const choices = ["allow_once", "allow_session", "allow_permanent", "deny"];
  assert.equal(resolveChoice("1", choices), "allow_once");
  assert.equal(resolveChoice("4", choices), "deny");
  assert.equal(resolveChoice("allow_session", choices), "allow_session");
  assert.equal(resolveChoice("ALLOW_PERMANENT", choices), "allow_permanent");
  assert.equal(resolveChoice("y", choices), "allow_once");
  assert.equal(resolveChoice("n", choices), "deny");
  assert.equal(resolveChoice("9", choices), undefined);
  assert.equal(resolveChoice("", choices), undefined);
  assert.equal(resolveChoice("maybe", choices), undefined);
});

test("a fixed decision answers without touching the terminal", async () => {
  const out = collector();
  const prompt = createTerminalApproval({ always: "deny", output: out.stream });
  const answer = await prompt(approvalRequest());
  assert.deepEqual(answer, { approval: { action: "accept", content: { decision: "deny" } } });
  assert.match(out.text(), /auto-answer: deny/);
});

test("a non-interactive stream denies rather than granting", async () => {
  const out = collector();
  const prompt = createTerminalApproval({
    output: out.stream,
    input: { isTTY: false, on() {}, removeListener() {} },
    nonInteractive: true,
  });
  const answer = await prompt(approvalRequest());
  // Failing closed matters: an unattended run must never silently allow a write.
  assert.deepEqual(answer, { approval: { action: "accept", content: { decision: "deny" } } });
  assert.match(out.text(), /denying this operation/);
});

test("single-use requests only offer allow_once and deny", async () => {
  const request = {
    requestState: "s",
    inputRequests: {
      approval: {
        method: "elicitation/create",
        params: {
          message: "Authorize?",
          requestedSchema: {
            properties: { decision: { enum: ["allow_once", "deny"] } },
          },
        },
      },
    },
  };
  const text = renderApproval(request);
  assert.match(text, /\[1\] Allow once/);
  assert.match(text, /\[2\] Deny/);
  assert.doesNotMatch(text, /Always allow/);
  assert.equal(resolveChoice("2", ["allow_once", "deny"]), "deny");
});
