// The native CLI's v4 sheets: eight columns of 192 × 208 frames. No model
// prompts, browser observations or conversation text are used by a companion.
export const BUILTIN_PETS = [
  ["codex", "Codex", "The original Codex companion", "5cd7af9cfeae88fe9c6e47a72460e0dc4c6fb04baf7fdc6cca14a212f0bf44d1"],
  ["dewey", "Dewey", "A blue droplet companion", "a53372a73467c5583fe512ed18443d1a8107cfb43060e4398ba1b7c679358ed0"],
  ["fireball", "Fireball", "A warm, bright companion", "2c257615a71374da82c802c78856e8a80ce336cfbeb1077b26051a5f6a7e49df"],
  ["rocky", "Rocky", "A steady companion", "524f3e6ac6508c60cf9d898940ea5f271ca66ca6b9bca66a73ac2b32296290fb"],
  ["seedy", "Seedy", "A growing companion", "4989cc19272ed944261bb4e29bfff842bbbb50aa9da1df9215cfbf47cb83f3ed"],
  ["stacky", "Stacky", "A companion for the next task", "f532c6701fb5f21d94be898e349f44fb218f1521d3747da1281f7b80fd3c35d1"],
  ["bsod", "BSOD", "A small computer companion", "0daf44c643c289772c01df97c5aa1383a4e2b05f4e50cf5e899c005a3876fbad"],
  ["null-signal", "Null Signal", "A mysterious companion", "6fe899a334f906ce863bf986e5fcf629615bc7513697bba5b075f69564bf5508"],
].map(([id, name, description, version]) => ({ id, name, description, version, builtin: true }));
export const PET_IMAGE_LIMIT = 20 * 1024 * 1024;
export const PET_LIBRARY_LIMIT = 12;
export const PET_LIBRARY_BYTES = 60 * 1024 * 1024;
export const PET_FRAME = { width: 192, height: 208, columns: 8, rows: 9 };
const row = (index, count) => Array.from({ length: count }, (_, i) => index * 8 + i);
export const PET_ANIMATIONS = {
  idle: { frames: row(0, 6), fps: 4 },
  "running-right": { frames: row(1, 8), fps: 10 },
  "running-left": { frames: row(2, 8), fps: 10 },
  waving: { frames: row(3, 4), fps: 6 },
  jumping: { frames: row(4, 5), fps: 6 },
  sad: { frames: row(5, 8), fps: 4 },
  waiting: { frames: row(6, 6), fps: 5 },
  typing: { frames: row(7, 6), fps: 6 },
  bounce: { frames: row(8, 6), fps: 6 },
};
export const builtinPet = id => {
  const pet = BUILTIN_PETS.find(pet => pet.id === id);
  return pet ? { ...pet, frame: PET_FRAME, animations: PET_ANIMATIONS } : null;
};
export function petActivity(chat) {
  if (!chat) return { id: "idle", label: "No chat selected", animation: "idle", animate: false };
  if (chat.archived || chat.workflowState === "archived") return { id: "idle", label: "Archived", animation: "idle", animate: false };
  if (chat.pendingRequest || chat.awaitingUser) return { id: "input", label: "Needs input", animation: "waiting", animate: true };
  if (chat.status === "error" || (chat.agent === "codex" && chat.agentSessionId && chat.goal?.threadId === chat.agentSessionId && chat.goal.status === "blocked")) return { id: "blocked", label: "Blocked", animation: "sad", animate: true };
  if (["running", "starting"].includes(chat.status)) return { id: "running", label: "Running", animation: "typing", animate: true };
  if (chat.status === "idle") return { id: "ready", label: "Ready", animation: "bounce", animate: true };
  return { id: "idle", label: ({ stopped: "Stopped", stopping: "Stopping" })[chat.status] || "Status not reported", animation: "idle", animate: false };
}
export function petAnimation(pet, name) {
  const animations = pet.animations || PET_ANIMATIONS;
  let current = name in animations ? name : "idle";
  const visited = new Set();
  while (animations[current] && !visited.has(current)) {
    visited.add(current); const item = animations[current];
    if (item.frames?.length) return item;
    current = item.fallback;
  }
  return { frames: [0], fps: 0 };
}
export function findPet(pets, name) {
  const key = name.trim().toLocaleLowerCase();
  const exact = pets.find(pet => pet.id === key);
  if (exact) return exact;
  const matches = pets.filter(pet => pet.name.toLocaleLowerCase() === key);
  if (matches.length > 1) throw new Error("More than one pet has that name. Choose one in /pets.");
  if (!matches.length) throw new Error(`Unknown pet: ${name}. Open /pets to choose an available pet.`);
  return matches[0];
}
