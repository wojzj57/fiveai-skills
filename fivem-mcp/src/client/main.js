import { createExecutor, failure, utf8Bytes } from "../shared/execution.js";

const resource = GetCurrentResourceName();
const event = (name) => `${resource}:${name}`;
const nonce = `${Date.now()}-${Math.random()}-${Math.random()}`;
let binding = null;
let pending = null;
let serial = 0;
const completed = new Set();
const execute = createExecutor({ resource, on, emit }, () => `${nonce}-${++serial}`);
const register = () => { if (!binding) emitNet(event("server:register"), nonce); };
register();
const registrationTimer = setInterval(register, 2000);

onNet(event("client:bind"), (value) => {
  if (source !== 65535 || !value || value.nonce !== nonce || value.serverId !== GetPlayerServerId(PlayerId())) return;
  if (![value.clientEpoch, value.challenge, value.logMarker].every(v => typeof v === "string" && v.length >= 8 && v.length <= 128)) return;
  if (pending && binding && value.clientEpoch !== binding.clientEpoch) return;
  binding = value;
  console.log(`FIVEAI_MCP_SESSION ${value.logMarker} ${value.serverId} ${value.clientEpoch}`);
  emitNet(event("server:ready"), value.clientEpoch, value.challenge);
});

onNet(event("client:execute"), (epoch, challenge, task) => {
  if (source !== 65535 || !binding || epoch !== binding.clientEpoch || challenge !== binding.challenge) return;
  if (!task || typeof task.id !== "string" || typeof task.code !== "string" || utf8Bytes(task.code) > 128 * 1024) return;
  if (completed.has(task.id)) return;
  if (pending) {
    if (pending.id === task.id && pending.digest === JSON.stringify(task) && pending.result) {
      emitNet(event("server:result"), epoch, challenge, task.id, JSON.stringify(pending.result));
    }
    return; // Never replace a running or unacknowledged invocation.
  }
  pending = { id: task.id, digest: JSON.stringify(task), result: null };
  const active = pending;
  void execute(task).then(result => {
    active.result = result;
    emitNet(event("server:result"), epoch, challenge, task.id, JSON.stringify(result));
  }).catch(() => {
    active.result = failure("EXECUTION_ERROR", "executor rejected", true);
    emitNet(event("server:result"), epoch, challenge, task.id, JSON.stringify(active.result));
  });
});

onNet(event("client:ack"), (epoch, challenge, id) => {
  if (source === 65535 && binding?.clientEpoch === epoch && binding.challenge === challenge && pending?.id === id && pending.result) {
    completed.add(id);
    if (completed.size > 1000) completed.delete(completed.values().next().value);
    pending = null;
  }
});

on("onClientResourceStop", name => { if (name === resource) clearInterval(registrationTimer); });
