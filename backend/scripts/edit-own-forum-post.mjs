#!/usr/bin/env node
/**
 * Replace the text of one of the operator's own forum posts, in place.
 *
 * The pinned map changes when the site changes, and the forum lets a wallet open one discussion
 * every two hours — so a corrected map could otherwise not replace the old one until the limit
 * passed, and the board would show outdated guidance in the meantime. This edits only a post the
 * named wallet wrote, keeps its id, pin and position, and records when it was edited.
 *
 *     node edit-own-forum-post.mjs --chain 84532 --post <id> --wallet <0x...> --file <path>
 *     (the text may also be passed base64-encoded with --b64 <...>)
 */
import mongoose from "mongoose";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const chainId = Number(value("--chain"));
const postId = value("--post");
const wallet = (value("--wallet") ?? "").toLowerCase();
const raw = value("--file") ? readFileSync(value("--file"), "utf8") : value("--b64") ? Buffer.from(value("--b64"), "base64").toString("utf8") : null;
/* The same text the posting script sends: Windows line endings normalised, trailing space trimmed. */
const text = raw === null ? null : raw.replace(/\r\n/g, "\n").trim();
if (!Number.isInteger(chainId) || !postId || !wallet || !text) {
  console.error("usage: edit-own-forum-post.mjs --chain <id> --post <id> --wallet <0x...> (--file <path> | --b64 <text>)");
  process.exit(1);
}
if (text.length > 4000) {
  console.error(`the text is ${text.length} characters; the forum's limit is 4000`);
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}
await mongoose.connect(uri);
const posts = mongoose.connection.collection("forumposts");
const _id = new mongoose.Types.ObjectId(postId);
const post = await posts.findOne({ _id, chainId });
if (!post) {
  console.error(`no post ${postId} on chain ${chainId}`);
  process.exit(1);
}
/* Only the named wallet's own post. */
if (String(post.wallet).toLowerCase() !== wallet) {
  console.error(`that post belongs to ${post.wallet}, not ${wallet}. Refusing.`);
  process.exit(1);
}
await posts.updateOne({ _id }, { $set: { message: text, editedAt: new Date() } });
console.log(`EDITED ${postId}: ${text.length} characters`);
await mongoose.disconnect();
