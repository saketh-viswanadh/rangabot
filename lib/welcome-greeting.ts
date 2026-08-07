import greetingContent from "../content/welcome-greetings.json" with { type: "json" };

export type WelcomeGreeting = { withName: string; withoutName: string };

export const welcomeGreetings = greetingContent.greetings as WelcomeGreeting[];

export function chooseGreetingIndex(
  currentIndex: number,
  random: () => number = Math.random,
) {
  if (welcomeGreetings.length < 2) return 0;
  const candidates = welcomeGreetings.map((_, index) => index).filter((index) => index !== currentIndex);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}

export function formatWelcomeGreeting(index: number, preferredName: string) {
  const greeting = welcomeGreetings[index] ?? welcomeGreetings[0];
  const name = preferredName.trim();
  return name ? greeting.withName.replace("{name}", name) : greeting.withoutName;
}
