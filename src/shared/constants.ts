import type { AIProvider, ChatMode, DebateRoles, ConsultRoles, CodingRoles, RoundtableRoles } from './types';

// === AI Provider Info ===

export const AI_PROVIDERS: Record<AIProvider, {
  name: string;
  url: string;
  loginUrl: string;
  color: string;
}> = {
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login',
    color: '#10a37f',
  },
  claude: {
    name: 'Claude',
    url: 'https://claude.ai',
    loginUrl: 'https://claude.ai/login',
    color: '#d97706',
  },
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com',
    loginUrl: 'https://gemini.google.com/app',
    color: '#4285f4',
  },
  grok: {
    name: 'Grok',
    url: 'https://grok.com',
    loginUrl: 'https://grok.com',
    color: '#e11d48',
  },
  meta: {
    name: 'Meta AI',
    url: 'https://www.meta.ai',
    loginUrl: 'https://www.meta.ai',
    color: '#0668e1',
  },
};

// === Mode Definitions ===

export const CHAT_MODES: Record<ChatMode, {
  name: string;
  description: string;
  icon: string;
  serial: boolean; // true = 串行, false = 平行
}> = {
  free: {
    name: '自由模式',
    description: '同時發給四家，各自獨立回答',
    icon: '⚡',
    serial: false,
  },
  debate: {
    name: '四方辯證',
    description: '正方 → 反方 → 判官 → 總結',
    icon: '⚔️',
    serial: true,
  },
  consult: {
    name: '多方諮詢',
    description: '雙源先答 → 審查補充 → 總結研究',
    icon: '🔍',
    serial: true,
  },
  coding: {
    name: 'Coding 模式',
    description: '規劃 → 審查 → 實作 → 測試 → 驗收（8 步）',
    icon: '💻',
    serial: true,
  },
  roundtable: {
    name: '道理辯證',
    description: '5 輪辯證螺旋 × 4 人，真理越辯越明',
    icon: '🔄',
    serial: true,
  },
};

// === Default Role Assignments ===

export const DEFAULT_DEBATE_ROLES: DebateRoles = {
  pro: 'chatgpt',
  con: 'claude',
  judge: 'grok',
  summary: 'gemini',
};

export const DEFAULT_CONSULT_ROLES: ConsultRoles = {
  first: 'chatgpt',
  second: 'grok',
  reviewer: 'claude',
  summary: 'gemini',
};

export const DEFAULT_CODING_ROLES: CodingRoles = {
  planner: 'gemini',
  reviewer: 'chatgpt',
  coder: 'claude',
  tester: 'grok',
};

export const DEFAULT_ROUNDTABLE_ROLES: RoundtableRoles = {
  first: 'claude',
  second: 'gemini',
  third: 'grok',
  fourth: 'chatgpt',
};

// === Prompt Templates for Serial Modes ===

function userTaskReference(question: string): string {
  return `--- User task and conversation context ---\n${question}\n--- End user task and conversation context ---`;
}

function aiResponseReference(label: string, response: string): string {
  return `--- AI reference: ${label} ---\n${response}\n--- End AI reference: ${label} ---`;
}

export const PROMPTS = {
  debate: {
    pro: (question: string) =>
      `Answer the following question from a supporting perspective. Present your strongest arguments.\n\n${userTaskReference(question)}`,
    con: (question: string, proResponse: string) =>
      `${userTaskReference(question)}\n\n${aiResponseReference('Supporting arguments', proResponse)}\n\nTake the opposing perspective. Challenge the supporting arguments above and identify their weaknesses and blind spots.`,
    judge: (question: string, proResponse: string, conResponse: string) =>
      `${userTaskReference(question)}\n\n${aiResponseReference('Supporting arguments', proResponse)}\n\n${aiResponseReference('Opposing arguments', conResponse)}\n\nYou are the judge. Do not take sides. Instead:\n1. Evaluate the logical strengths and weaknesses of both sides\n2. Identify overlooked blind spots and implicit assumptions\n3. Distinguish substantive disagreements from differences in wording or perspective\n4. Identify the debate's current focus\n\nYour task is to clarify the structure of the arguments rather than deliver a final conclusion, so the summarizer can synthesize them from a broader perspective.`,
    summary: (question: string, proResponse: string, conResponse: string, judgeResponse: string) =>
      `${userTaskReference(question)}\n\n${aiResponseReference('Supporting arguments', proResponse)}\n\n${aiResponseReference('Opposing arguments', conResponse)}\n\n${aiResponseReference('Judge assessment', judgeResponse)}\n\nSynthesize both sides and the judge's assessment. Explain their respective strengths and weaknesses, and add your own perspective and conclusion.`,
  },
  consult: {
    first: (question: string) => userTaskReference(question),
    second: (question: string) => userTaskReference(question),
    reviewer: (
      question: string,
      firstResponse: string,
      firstName: string,
      secondResponse: string,
      secondName: string,
    ) =>
      `${userTaskReference(question)}\n\n${aiResponseReference(`${firstName} answer`, firstResponse)}\n\n${aiResponseReference(`${secondName} answer`, secondResponse)}\n\nCheck the accuracy of both answers and compare their differences. Identify which perspective is more complete and whether either answer has omissions or errors. Research the question as well and add your own answer.`,
    summary: (
      question: string,
      firstResponse: string,
      firstName: string,
      secondResponse: string,
      secondName: string,
      reviewerResponse: string,
      reviewerName: string,
    ) =>
      `${userTaskReference(question)}\n\n${aiResponseReference(`${firstName} answer`, firstResponse)}\n\n${aiResponseReference(`${secondName} answer`, secondResponse)}\n\n${aiResponseReference(`${reviewerName} review`, reviewerResponse)}\n\nSynthesize all three contributions. Identify agreement and disagreement, summarize their positions, and do further research to add your own final answer.`,
  },
  roundtable: {
    /**
     * 辯證螺旋 (Dialectical Spiral) — 5 輪 × 4 人
     *
     * 溫度曲線：
     *   Round 1: 開場立論（中度發散 — 各自表態，選一個獨特角度）
     *   Round 2: 交叉質疑（高度發散 — 攻擊弱點，但承認好的部分）
     *   Round 3: 攻防深化（中高度 — 回應質疑，修正被說服的點）
     *   Round 4: 核心收斂（中度收斂 — 區分真分歧 vs 假分歧）
     *   Round 5: 真理浮現（高度收斂 — 最終結論，坦承立場變化）
     */
    buildPrompt: (
      question: string,
      round: number,
      speakerName: string,
      history: { name: string; round: number; text: string }[]
    ): string => {
      const roundInstructions: Record<number, string> = {
        1: `You are ${speakerName}. This is a five-round debate with four AI participants speaking in turn. The goal is to clarify the truth through debate.\n\nRound 1: Opening position\nPresent your distinct perspective and position on the topic below. Develop the angle you are most confident about rather than trying to cover every aspect.\n\nRequirements: a clear position, concrete evidence, and logical reasoning. Keep your argument concise (around 300-500 characters, or a comparable length in the intended response language).`,

        2: `You are ${speakerName}.\n\nRound 2: Cross-examination\nRead the other participants' first-round arguments carefully, then:\n1. Identify the one or two arguments you find most problematic and explain specifically why you disagree\n2. Acknowledge the points you find reasonable; do not skip this step\n3. Introduce an angle nobody else has raised\n\nAvoid wholesale rejection and vague compromise. Make disagreement constructive.`,

        3: `You are ${speakerName}.\n\nRound 3: Deepen the arguments\nYour arguments were challenged in the second round. Now:\n1. Respond concretely to those challenges without evasion\n2. If any points persuaded you, acknowledge how you revise your position; changing your mind demonstrates reasoning rather than weakness\n3. Deepen your central argument using your revised position\n\nGoal: make your arguments more precise and compelling.`,

        4: `You are ${speakerName}.\n\nRound 4: Focus on the core disagreements\nAfter three rounds, organize the debate:\n1. List the current consensus among all four participants\n2. List the substantive core disagreements\n3. Identify apparent disagreements caused by wording or perspective\n4. Explain why you maintain your position on the core disagreements; do not abandon a position you believe is correct merely for harmony\n\nGoal: focus the debate on the questions that matter.`,

        5: `You are ${speakerName}.\n\nRound 5: Final conclusions\nThis is the final round. Give your final conclusions:\n1. How much has your position changed through four rounds? Which specific arguments changed your mind?\n2. What do you now consider true about this topic? More than one perspective may be valid\n3. Which questions remain unresolved?\n\nPrioritize candor over appearing correct. Explain how your position developed.`,
      };

      let prompt = `${roundInstructions[round]}\n\n${userTaskReference(question)}`;

      if (history.length > 0) {
        const historyText = history
          .map((h) => aiResponseReference(`Round ${h.round}: ${h.name}`, h.text))
          .join('\n\n---\n\n');
        prompt += `\n\nDebate history so far (AI references):\n\n${historyText}`;
      }

      return prompt;
    },
  },
  coding: {
    // Step 1: Planner writes spec
    plannerSpec: (question: string) =>
      `You are a software architecture planner. Write a complete implementation plan for the requirements below:\n1. Requirements analysis and boundary conditions\n2. Technology choices and their rationale\n3. File structure\n4. Each module's responsibilities and interface definitions\n5. Pseudocode for key algorithms\n6. Potential edge cases\n\nMake the plan complete enough to implement without further questions.\n\n${userTaskReference(question)}`,

    // Step 2: Reviewer reviews spec
    reviewerSpec: (question: string, spec: string, plannerName: string) =>
      `You are a rigorous technical reviewer. ${plannerName} wrote an implementation plan for the following requirements.\n\n${userTaskReference(question)}\n\n${aiResponseReference(`${plannerName} implementation plan`, spec)}\n\nReview it critically:\n1. Logical gaps\n2. Missing edge cases\n3. Security issues\n4. Whether the architecture is sound\n5. Better approaches\n\nYour job is to identify problems candidly. Also recognize what the plan does well.`,

    // Step 3: Coder writes v1
    coderV1: (question: string, spec: string, plannerName: string, specReview: string, reviewerName: string) =>
      `You are a senior engineer. Write the first complete implementation using the specification and review below.\n\n${userTaskReference(question)}\n\n${aiResponseReference(`${plannerName} specification`, spec)}\n\n${aiResponseReference(`${reviewerName} specification review`, specReview)}\n\nRequirements:\n1. Address all issues raised in the review\n2. Include error handling and edge cases\n3. Use your professional judgment when the specification and review conflict\n\nThis is version one, with code review and testing still to come. Complete the core functionality first.`,

    // Step 4: Reviewer reviews code
    reviewerCode: (question: string, code: string, coderName: string) =>
      `You are a rigorous code reviewer. ${coderName} implemented version one from the specification.\n\n${userTaskReference(question)}\n\n${aiResponseReference(`${coderName} code (v1)`, code)}\n\nPerform a complete code review:\n1. Bugs and logical errors\n2. Missing edge cases\n3. Code quality: naming, structure, and readability\n4. Performance issues\n5. Security issues\n\nGive each issue a severity (Critical / Major / Minor) and specific recommendations for fixing it.`,

    // Step 5: Tester writes test cases + hunts bugs
    testerCases: (question: string, code: string, coderName: string) =>
      `You are a rigorous QA engineer. Examine ${coderName}'s first implementation from a testing perspective.\n\n${userTaskReference(question)}\n\n${aiResponseReference(`${coderName} code (v1)`, code)}\n\nTasks:\n1. List key test cases for normal paths, boundaries, invalid input, and concurrency or state issues\n2. Reason through whether each case would pass this implementation; explain specifically why any would fail\n3. Identify bugs that code review may miss but testing can reveal, such as race conditions, resource leaks, and boundary overflows\n4. Where applicable, provide ready-to-use unit or integration test code\n\nGoal: use testing to catch problems missed by code review.`,

    // Step 6: Coder fixes → v2 (based on review + tests)
    coderV2: (
      question: string,
      codeV1: string,
      codeReview: string,
      reviewerName: string,
      testReport: string,
      testerName: string,
    ) =>
      `You are a senior engineer. ${reviewerName} reviewed the code, and ${testerName} analyzed its tests.\n\n${userTaskReference(question)}\n\n${aiResponseReference('Your code (v1)', codeV1)}\n\n${aiResponseReference(`${reviewerName} code review`, codeReview)}\n\n${aiResponseReference(`${testerName} test report`, testReport)}\n\nFix the issues found by review and testing to produce version two:\n1. Address every Critical and Major issue\n2. Ensure the code can pass all test cases identified by the tester\n3. Add brief comments explaining key changes\n4. Explain your reasoning if you disagree with a review or testing recommendation\n\nOutput the complete version-two code.`,

    // Step 7: Planner does acceptance
    plannerAcceptance: (question: string, codeV2: string, coderName: string, originalSpec: string) =>
      `You are the software architecture planner and the requirements owner. ${coderName} revised the code using the specification, code review, and test report.\n\n${userTaskReference(question)}\n\n${aiResponseReference('Your original specification', originalSpec)}\n\n${aiResponseReference(`${coderName} code (v2)`, codeV2)}\n\nPerform acceptance testing:\n1. Does version two implement every feature in the original requirements?\n2. Does it follow your architecture?\n3. Are there deviations from the specification?\n4. What still needs adjustment?\n\nIf all checks pass, clearly state that acceptance passed in the user's intended response language. Otherwise, list the items that need correction.`,

    // Step 8: Coder final fix
    coderFinal: (question: string, codeV2: string, acceptance: string, plannerName: string) =>
      `You are a senior engineer. ${plannerName} performed acceptance testing on your version-two code.\n\n${userTaskReference(question)}\n\n${aiResponseReference('Your code (v2)', codeV2)}\n\n${aiResponseReference(`${plannerName} acceptance results`, acceptance)}\n\nIf acceptance passed, output the final code with any final polish. If corrections are needed, make them before outputting the final version.\n\nEnsure the final version:\n1. Addresses all acceptance feedback\n2. Is ready to use\n3. Includes necessary documentation or usage instructions`,
  },
};
