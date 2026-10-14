import { randomUUID } from "node:crypto";
import { UstaadAction, PendingConfirmation } from "../shared/contracts";
import { describeActions } from "./action-protocol";

/**
 * Actions that were allowed to happen in principle but need a human "yes"
 * before they touch the desktop. The island renders one card per entry.
 */
export class ConfirmationQueue {
  private pendingConfirmations: PendingConfirmation[] = [];

  enqueue(interactionId: number, actions: UstaadAction[], reason: string): PendingConfirmation {
    const pendingConfirmation: PendingConfirmation = {
      id: randomUUID(),
      interactionId,
      actions,
      reason: reason || describeActions(actions),
      createdAtIso: new Date().toISOString(),
    };
    this.pendingConfirmations = [pendingConfirmation, ...this.pendingConfirmations].slice(0, 5);
    return pendingConfirmation;
  }

  list(): PendingConfirmation[] {
    return [...this.pendingConfirmations];
  }

  /** The oldest entry, which is the one the user is being asked about now. */
  nextPending(): PendingConfirmation | null {
    return this.pendingConfirmations[this.pendingConfirmations.length - 1] ?? null;
  }

  take(id: string): PendingConfirmation | null {
    const pendingConfirmation = this.pendingConfirmations.find(
      (queuedConfirmation) => queuedConfirmation.id === id,
    ) ?? null;
    if (pendingConfirmation) {
      this.remove(id);
    }
    return pendingConfirmation;
  }

  remove(id: string): boolean {
    const remainingConfirmations = this.pendingConfirmations.filter(
      (queuedConfirmation) => queuedConfirmation.id !== id,
    );
    if (remainingConfirmations.length === this.pendingConfirmations.length) {
      return false;
    }
    this.pendingConfirmations = remainingConfirmations;
    return true;
  }

  clear(): void {
    this.pendingConfirmations = [];
  }

  /** Answers slower than the timeout are dropped so stale cards cannot fire. */
  expireOlderThan(now: Date, maximumAgeMilliseconds: number): PendingConfirmation[] {
    const expiredConfirmations = this.pendingConfirmations.filter(
      (queuedConfirmation) =>
        now.getTime() - new Date(queuedConfirmation.createdAtIso).getTime() > maximumAgeMilliseconds,
    );
    if (expiredConfirmations.length) {
      const expiredIds = new Set(expiredConfirmations.map((expiredConfirmation) => expiredConfirmation.id));
      this.pendingConfirmations = this.pendingConfirmations.filter(
        (queuedConfirmation) => !expiredIds.has(queuedConfirmation.id),
      );
    }
    return expiredConfirmations;
  }
}

export type ConfirmationAnswer = "approve" | "reject" | "unknown";

const approvalPhrases = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "go",
  "go ahead",
  "do it",
  "run it",
  "send it",
  "confirm",
  "approve",
  "please do",
  "that's right",
  "thats right",
  "sounds good",
  "alright",
  "all right",
  "correct",
];

const rejectionPhrases = [
  "no",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "cancel",
  "stop",
  "skip",
  "dont",
  "don't",
  "do not",
  "never",
  "never mind",
  "nevermind",
  "forget it",
  "abort",
  "not now",
  "leave it",
];

function normalizeSpokenAnswer(transcriptText: string): string {
  return transcriptText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads a spoken yes/no. Rejection is checked first on purpose: when someone
 * says "no, don't do it", the safe interpretation must win.
 */
export function interpretConfirmationAnswer(transcriptText: string): ConfirmationAnswer {
  const normalizedAnswer = normalizeSpokenAnswer(transcriptText);
  if (!normalizedAnswer) {
    return "unknown";
  }

  const answerTokens = normalizedAnswer.split(" ");
  const containsPhrase = (phrase: string): boolean => {
    const phraseTokens = phrase.split(" ");
    if (phraseTokens.length === 1) {
      return answerTokens.includes(phrase);
    }
    return normalizedAnswer.includes(phrase);
  };

  if (rejectionPhrases.some(containsPhrase)) {
    return "reject";
  }
  if (approvalPhrases.some(containsPhrase)) {
    return "approve";
  }

  return "unknown";
}
