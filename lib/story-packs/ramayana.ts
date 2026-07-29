import type { StoryDraftPart, WordDocumentBrief, WordDraft } from "../word-documents.ts";
import { assembleStoryCollectionDraft } from "../word-documents.ts";

const stories: StoryDraftPart[] = [
  {
    title: "The Promise That Led to the Forest",
    paragraphs: [
      "Ayodhya buzzed with excitement: Prince Rama was to be crowned king. But inside the palace, Queen Kaikeyi remembered two promises King Dasharatha had once made her. She asked that her son Bharata be crowned and that Rama live in the forest for fourteen years. The king was heartbroken. He loved Rama dearly, yet he believed a promise must be kept.",
      "When Rama heard the news, he did not shout or blame anyone. He comforted his father and calmly prepared to leave. ‘If keeping Father’s word requires me to go,’ he said, ‘I will go with a peaceful heart.’ Sita insisted on joining her husband, even though forest life would be difficult. Lakshmana also chose to accompany his brother and protect them both.",
      "Dressed in simple clothes, the three left the palace behind. The people of Ayodhya followed them in tears, but Rama gently persuaded everyone to return home. His loyalty was not easy or comfortable. It meant giving up a crown, accepting hardship, and refusing to let anger rule his choices. Sita and Lakshmana showed another kind of loyalty: they freely shared the difficult road with someone they loved.",
    ],
    reflection: "Was Rama’s hardest act leaving the palace, or choosing not to be angry? Why?",
  },
  {
    title: "Bharata and the Sandals on the Throne",
    paragraphs: [
      "Bharata was away when Rama left Ayodhya. When he returned and learned what his mother Kaikeyi had asked for, he was horrified. He did not want a kingdom gained through Rama’s exile. With ministers, teachers, and members of the royal family, Bharata travelled to Chitrakuta to find his elder brother.",
      "‘Please come home and rule,’ Bharata begged. Rama embraced him, but explained that he had promised to complete fourteen years in the forest. Bharata could not persuade him to break that promise. At last, he asked for Rama’s sandals. He carried them back to Ayodhya and placed them on the throne as a sign that Rama remained the rightful king.",
      "Bharata lived simply at Nandigrama and governed as Rama’s caretaker, counting the years until his brother’s return. He could have enjoyed royal power, but he chose service instead. His loyalty was not blind agreement: he openly opposed the wrong that had been done, then found an honourable way to respect Rama’s decision. The empty sandals reminded everyone that leadership is not about grabbing a seat; it is about guarding a responsibility for the person and principles you serve.",
    ],
    reflection: "What made Bharata a leader even though he refused to call himself king?",
  },
  {
    title: "Hanuman’s Leap Across the Sea",
    paragraphs: [
      "The search for Sita brought the vanara scouts to the edge of a vast sea. Lanka lay far beyond the waves, and for a moment no one knew how to reach it. Then wise Jambavan reminded Hanuman of the strength and courage within him. Hanuman grew in confidence, climbed a mountain, and sprang into the sky.",
      "After crossing the ocean and entering Lanka carefully, Hanuman found Sita in the Ashoka grove. She was surrounded by guards and saddened by her captivity, but she remained firm. Hanuman first spoke gently from hiding so he would not frighten her. Then he gave her Rama’s ring. It was a small object carrying a huge message: Rama had not forgotten her, and help was coming.",
      "Sita gave Hanuman a jewel and a message to take back. Hanuman returned across the sea and told Rama exactly where she was. His great leap is exciting, but his loyalty showed in quieter choices too. He listened, observed, carried proof, and placed Sita’s safety above his wish to appear heroic. Strength took him across the ocean; care and good judgement allowed him to complete the mission.",
    ],
    reflection: "Which helped Hanuman more—his strength, his courage, or his careful thinking?",
  },
  {
    title: "Jatayu’s Courage in the Sky",
    paragraphs: [
      "Jatayu, an elderly vulture king and friend of King Dasharatha, heard Sita calling for help as Ravana carried her toward Lanka. Jatayu knew he was old and that Ravana was powerful. He could have looked away. Instead, loyalty to his friend’s family made him rise into the sky and challenge the abductor.",
      "Jatayu fought fiercely, damaging Ravana’s chariot and trying to free Sita. Ravana finally struck him down and continued toward Lanka. The battle left Jatayu terribly wounded, but his effort was not useless: he had slowed Ravana, shown Sita that she was not abandoned, and learned the direction in which Ravana had travelled.",
      "Later, Rama and Lakshmana found Jatayu. With his remaining strength, the brave bird told Rama what had happened and pointed them toward the south. Rama held him with gratitude and grief, honouring him like a member of his own family when he died. Jatayu did not win the fight, yet the Ramayana remembers his courage. His story teaches that loyalty is measured not only by victory, but also by choosing to help when helping is difficult and the outcome is uncertain.",
    ],
    reflection: "Can an action still be brave and valuable when it does not completely succeed?",
  },
];

export function buildRamayanaStoryCollection(brief: WordDocumentBrief): WordDraft {
  return assembleStoryCollectionDraft(brief, stories);
}
