/**
 * A short random id. `crypto.randomUUID` only exists on https or localhost, and a phone
 * on the home network loads the app over plain http, so build it from getRandomValues.
 */
export const shortId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
