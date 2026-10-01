#!/usr/bin/env node
/**
 * Remove a forum post, by id, as the operator.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT, and why it barely exists. The board's value is that
 * nothing written on it can be taken back: a claim stays attached to whoever made it, which is what
 * makes a track record mean anything. A delete endpoint would destroy that for every participant.
 *
 * This exists for the operator's own mistakes — a message that should not have been published in
 * the form it was published in — and it prints what it removed so the removal is not itself silent.
 * It refuses to touch a post that is not the operator's.
 *
 *     node backend/scripts/delete-forum-post.mjs --chain 84532 --post <id> --wallet 0x...
 */

import mongoose from "mongoose";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const chainId = Number(value("--chain"));
const postId = value("--post");
const wallet = (value("--wallet") ?? "").toLowerCase();

if (!Number.isInteger(chainId) || !postId || !wallet) {
  console.error("usage: delete-forum-post.mjs --chain <id> --post <id> --wallet <0x...>");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}

await mongoose.connect(uri);
const posts = mongoose.connection.collection("forumposts");

let _id;
try {
  _id = new mongoose.Types.ObjectId(postId);
} catch {
  console.error(`"${postId}" is not a post id`);
  process.exit(1);
}

const post = await posts.findOne({ _id, chainId });
if (!post) {
  console.error(`no post ${postId} on chain ${chainId}`);
  process.exit(1);
}

/* Only the named wallet's own post. A tool that can delete anyone's is a different tool. */
if (String(post.wallet).toLowerCase() !== wallet) {
  console.error(`that post belongs to ${post.wallet}, not ${wallet}. Refusing.`);
  process.exit(1);
}

console.log(`removing ${postId} by ${post.wallet}:`);
console.log(`  ${String(post.message).slice(0, 120).replace(/\s+/g, " ")}`);

await posts.deleteOne({ _id });

const left = await posts.countDocuments({ chainId });
console.log(`removed. ${left} post(s) remain on chain ${chainId}.`);

await mongoose.disconnect();
