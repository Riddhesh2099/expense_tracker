// Data access for the app. Normally this IS Firestore; in guest preview the same functions run against
// localStorage (src/localStore.ts), so pages just import from "./store" and work in both modes.
import * as remote from "firebase/firestore";
import * as local from "./localStore";

const GUEST_FLAG = "ridv-guest";

export const isGuest = (() => {
  try {
    // ?preview=1 is a shareable "try it" link (and how headless screenshots enter preview).
    if (new URLSearchParams(window.location.search).get("preview") === "1") localStorage.setItem(GUEST_FLAG, "1");
    return localStorage.getItem(GUEST_FLAG) === "1";
  } catch {
    return false;
  }
})();

export function enterGuestPreview() {
  localStorage.setItem(GUEST_FLAG, "1");
  window.location.assign("/");
}

export function exitGuestPreview(wipe: boolean) {
  localStorage.removeItem(GUEST_FLAG);
  if (wipe) local.clearGuestData();
  window.location.assign("/");
}

// ponytail: the local backend only implements what this app calls; casting it to Firestore's types keeps call
// sites unchanged. Adding a new Firestore call means adding it to localStore.ts too.
const impl = (isGuest ? local : remote) as unknown as typeof remote;

export const {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} = impl;
export { Timestamp } from "firebase/firestore";
