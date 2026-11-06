/**
 * Technical Support Template
 * For IT helpdesks, software support, hardware troubleshooting
 */

export default {
  name: "Technical Support",
  category: "support",
  description: "IT helpdesk for software/hardware issues with troubleshooting guides",
  icon: "Laptop",

  defaultSystemPrompt: `You are a technical support agent for [COMPANY_NAME].

Your role:
- Diagnose technical issues efficiently
- Guide users through troubleshooting steps
- Escalate complex problems to specialists
- Log all issues for tracking

Guidelines:
- Ask clarifying questions to understand the problem
- Provide step-by-step instructions clearly
- Be patient and avoid technical jargon
- Confirm issue resolution before ending call
- Create support ticket for unresolved issues

Available actions:
- Check system status
- Search knowledge base
- Create support ticket
- Transfer to specialist
- Schedule callback`,

  defaultIvrMenu: [
    { digit: "1", action: "continue", label: "Technical Support" },
    { digit: "2", action: "transfer", target: "billing", label: "Billing Questions" },
    { digit: "3", action: "transfer", target: "sales", label: "Sales" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Speak to Human Agent" }
  ],

  defaultBusinessHours: {
    timezone: "UTC",
    monday: { open: "09:00", close: "17:00" },
    tuesday: { open: "09:00", close: "17:00" },
    wednesday: { open: "09:00", close: "17:00" },
    thursday: { open: "09:00", close: "17:00" },
    friday: { open: "09:00", close: "17:00" },
    saturday: null,
    sunday: null
  },

  defaultKnowledgeBase: [
    {
      category: "faq",
      question: "How do I reset my password?",
      answer: "Visit the login page and click 'Forgot Password'. Enter your email address to receive a password reset link. The link expires in 24 hours.",
      keywords: "password,reset,forgot,login,email"
    },
    {
      category: "faq",
      question: "Why can't I log in?",
      answer: "Common reasons: 1) Caps Lock is on, 2) Password expired, 3) Account locked after 5 failed attempts. Try resetting your password or contact support.",
      keywords: "login,cant,locked,access,account"
    },
    {
      category: "faq",
      question: "How do I install the software?",
      answer: "1) Download installer from our website, 2) Run the .exe file, 3) Follow on-screen instructions, 4) Restart computer when prompted. Requires admin privileges.",
      keywords: "install,setup,download,software"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [COMPANY_NAME] technical support. My name is [AGENT_NAME]. How can I help you today?",
      keywords: "greeting,opening,hello"
    },
    {
      category: "script",
      question: "Issue resolved",
      answer: "Great! I'm glad we resolved that. Is there anything else I can help you with today?",
      keywords: "resolved,fixed,solved,done"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-GuyNeural",
    language: "en"
  }
};
