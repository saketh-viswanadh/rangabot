export type WelcomeLine = {
  text: string;
  credit: string;
  kind: "QUOTE" | "JOKE" | "THOUGHT";
};

export const welcomeLines: WelcomeLine[] = [
  { text: "The best way to predict the future is to invent it.", credit: "Alan Kay", kind: "QUOTE" },
  { text: "Simplicity is the soul of efficiency.", credit: "Austin Freeman", kind: "QUOTE" },
  { text: "Great things are done by a series of small things brought together.", credit: "Vincent van Gogh", kind: "QUOTE" },
  { text: "The secret of getting ahead is getting started.", credit: "Mark Twain", kind: "QUOTE" },
  { text: "It always seems impossible until it’s done.", credit: "Nelson Mandela", kind: "QUOTE" },
  { text: "The most courageous act is still to think for yourself. Aloud.", credit: "Coco Chanel", kind: "QUOTE" },
  { text: "First, solve the problem. Then, write the code.", credit: "John Johnson", kind: "QUOTE" },
  { text: "Make it work, make it right, make it fast.", credit: "Kent Beck", kind: "QUOTE" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", credit: "Harold Abelson", kind: "QUOTE" },
  { text: "Why did the developer go broke? They used up all their cache.", credit: "A tiny local joke", kind: "JOKE" },
  { text: "I told my code to behave. It threw an exception.", credit: "Rangabot", kind: "JOKE" },
  { text: "There are 10 kinds of people: those who understand binary and those who don’t.", credit: "A classic developer joke", kind: "JOKE" },
  { text: "My rubber duck reviewed the code. It had no comments.", credit: "Rangabot", kind: "JOKE" },
  { text: "Why was the function calm? It knew when to return.", credit: "Rangabot", kind: "JOKE" },
  { text: "The bug said it was a feature. The roadmap asked for evidence.", credit: "Rangabot", kind: "JOKE" },
  { text: "I would tell you a UDP joke, but you might not get it.", credit: "A classic network joke", kind: "JOKE" },
  { text: "The local model walked into a cloud. It came straight back for privacy.", credit: "Rangabot", kind: "JOKE" },
  { text: "Small steps, thoughtfully repeated, become remarkable things.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "A clear question is already the beginning of a good answer.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Build the smallest version that can teach you something real.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Privacy feels quiet because nothing unnecessary leaves the room.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Good tools disappear into the rhythm of the work.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "A useful pause can save an afternoon of clever mistakes.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Curiosity turns uncertainty from a wall into a doorway.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Leave the code a little kinder than you found it.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "The best next step is often the one you can test today.", credit: "Rangabot", kind: "THOUGHT" },
  { text: "Simple does not mean plain; it means every detail has a reason.", credit: "Rangabot", kind: "THOUGHT" },
];
