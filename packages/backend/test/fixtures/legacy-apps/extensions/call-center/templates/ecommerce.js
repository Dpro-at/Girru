/**
 * E-commerce Support Template
 * For order tracking, returns, product inquiries
 */

export default {
  name: "E-commerce Support",
  category: "ecommerce",
  description: "Order tracking, returns, and product support for online stores",
  icon: "ShoppingCart",

  defaultSystemPrompt: `You are a customer service representative for [STORE_NAME].

Your role:
- Track orders and shipping status
- Process returns and refunds
- Answer product questions
- Handle complaints professionally

Guidelines:
- Be helpful, patient, and solution-oriented
- Always get order number for tracking
- Explain return policy clearly (30-day window)
- Offer alternatives before processing returns
- Create support ticket for complex issues

Available actions:
- Track order status
- Initiate return
- Process refund
- Update shipping address
- Answer product questions

Common issues:
- Order not received
- Wrong item shipped
- Damaged product
- Refund request`,

  defaultIvrMenu: [
    { digit: "1", action: "continue", label: "Track My Order" },
    { digit: "2", action: "continue", label: "Returns & Refunds" },
    { digit: "3", action: "continue", label: "Product Questions" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Speak to Agent" }
  ],

  defaultBusinessHours: {
    timezone: "UTC",
    monday: { open: "00:00", close: "23:59" },
    tuesday: { open: "00:00", close: "23:59" },
    wednesday: { open: "00:00", close: "23:59" },
    thursday: { open: "00:00", close: "23:59" },
    friday: { open: "00:00", close: "23:59" },
    saturday: { open: "00:00", close: "23:59" },
    sunday: { open: "00:00", close: "23:59" }
  },

  defaultKnowledgeBase: [
    {
      category: "faq",
      question: "Where is my order?",
      answer: "To track your order, I need your order number (found in confirmation email). Orders typically ship within 1-2 business days and arrive in 3-5 days.",
      keywords: "order,tracking,shipping,delivery,where"
    },
    {
      category: "faq",
      question: "How do I return an item?",
      answer: "We accept returns within 30 days of purchase. Item must be unused with tags attached. Provide order number to start return process. Refunds issued within 5-7 days.",
      keywords: "return,refund,exchange,money back"
    },
    {
      category: "faq",
      question: "What's your shipping policy?",
      answer: "Free standard shipping on orders $50+. Express shipping available for $15. International shipping varies by country. All orders ship within 1-2 business days.",
      keywords: "shipping,delivery,free,cost"
    },
    {
      category: "faq",
      question: "How do I change my order?",
      answer: "If order hasn't shipped yet, we can modify it. Contact us ASAP with order number. Once shipped, you'll need to return and reorder.",
      keywords: "change,modify,update,cancel"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [STORE_NAME] customer support. My name is [AGENT_NAME]. How can I help you today?",
      keywords: "greeting,opening,hello"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-JennyNeural",
    language: "en"
  }
};
