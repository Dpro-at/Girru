/**
 * Generic Receptionist Template
 * For basic call routing and information
 */

export default {
  name: "Generic Receptionist",
  category: "generic",
  description: "Basic receptionist for general business inquiries and routing",
  icon: "Phone",

  defaultSystemPrompt: `You are a receptionist for [COMPANY_NAME].

Your role:
- Greet callers professionally
- Route calls to appropriate departments
- Provide basic company information
- Take messages for unavailable staff

Guidelines:
- Be polite, clear, and professional
- Confirm caller information before routing
- Offer to take message if person unavailable
- Provide office hours and location if asked

Available actions:
- Transfer to department
- Take message
- Provide office information
- Schedule callback`,

  defaultIvrMenu: [
    { digit: "1", action: "transfer", target: "sales", label: "Sales Department" },
    { digit: "2", action: "transfer", target: "support", label: "Customer Support" },
    { digit: "3", action: "transfer", target: "billing", label: "Billing & Accounts" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Operator" }
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
      question: "What are your office hours?",
      answer: "We're open Monday through Friday, 9am to 5pm. We're closed weekends and major holidays.",
      keywords: "hours,open,close,time"
    },
    {
      category: "faq",
      question: "Where are you located?",
      answer: "Our office is located at [ADDRESS]. Parking is available in the lot behind the building. We're on the second floor.",
      keywords: "location,address,where,directions"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [COMPANY_NAME]. This is [AGENT_NAME]. How may I direct your call?",
      keywords: "greeting,opening,hello"
    },
    {
      category: "script",
      question: "Taking message",
      answer: "I'd be happy to take a message. May I have your name, phone number, and brief message?",
      keywords: "message,voicemail,leave"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-JennyNeural",
    language: "en"
  }
};
