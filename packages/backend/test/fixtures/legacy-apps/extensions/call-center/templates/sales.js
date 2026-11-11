/**
 * Sales Qualifying Template
 * For lead qualification, product demos, pricing inquiries
 */

export default {
  name: "Sales Qualifying",
  category: "sales",
  description: "Lead qualification and product inquiries for sales teams",
  icon: "TrendingUp",

  defaultSystemPrompt: `You are a sales representative for [COMPANY_NAME].

Your role:
- Qualify inbound leads (budget, timeline, decision-maker)
- Answer product questions and pricing
- Schedule demos with sales team
- Identify customer needs and pain points

Guidelines:
- Be enthusiastic and solution-focused
- Ask open-ended questions to understand needs
- Listen more than you talk (60/40 rule)
- Always get contact information
- Schedule follow-up or demo before ending call

Qualifying questions:
- What challenges are you facing?
- What's your timeline for implementation?
- Who else is involved in the decision?
- What's your budget range?

Available actions:
- Schedule demo
- Send pricing information
- Create lead record
- Transfer to account executive`,

  defaultIvrMenu: [
    { digit: "1", action: "continue", label: "New Customer Inquiry" },
    { digit: "2", action: "continue", label: "Existing Customer" },
    { digit: "3", action: "continue", label: "Pricing Information" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Speak to Sales Rep" }
  ],

  defaultBusinessHours: {
    timezone: "UTC",
    monday: { open: "08:00", close: "18:00" },
    tuesday: { open: "08:00", close: "18:00" },
    wednesday: { open: "08:00", close: "18:00" },
    thursday: { open: "08:00", close: "18:00" },
    friday: { open: "08:00", close: "17:00" },
    saturday: null,
    sunday: null
  },

  defaultKnowledgeBase: [
    {
      category: "faq",
      question: "How much does it cost?",
      answer: "Pricing starts at $99/month for our Starter plan. We offer Professional ($299/mo) and Enterprise (custom) plans. All plans include 14-day free trial.",
      keywords: "price,cost,pricing,plan,subscription"
    },
    {
      category: "faq",
      question: "Do you offer a free trial?",
      answer: "Yes! All plans include a 14-day free trial. No credit card required. You can cancel anytime during the trial with no charges.",
      keywords: "trial,free,demo,test"
    },
    {
      category: "faq",
      question: "What's included in each plan?",
      answer: "Starter: 5 users, 10GB storage. Professional: 25 users, 100GB, priority support. Enterprise: Unlimited users, custom storage, dedicated account manager.",
      keywords: "plan,features,include,tier"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [COMPANY_NAME] sales. This is [AGENT_NAME]. What brings you to us today?",
      keywords: "greeting,opening,hello"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-AriaNeural",
    language: "en"
  }
};
