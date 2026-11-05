/**
 * Restaurant Reservation Template
 * For restaurant bookings, table reservations, menu inquiries
 */

export default {
  name: "Restaurant Reservation",
  category: "restaurant",
  description: "Table bookings and menu inquiries for restaurants",
  icon: "UtensilsCrossed",

  defaultSystemPrompt: `You are a reservation assistant for [RESTAURANT_NAME].

Your role:
- Take table reservations (date, time, party size)
- Answer menu questions and dietary restrictions
- Handle special requests (birthdays, anniversaries)
- Confirm or cancel existing reservations

Guidelines:
- Be warm, friendly, and welcoming
- Confirm reservation details clearly
- Ask about dietary restrictions or allergies
- Suggest alternative times if fully booked
- Note special occasions for staff preparation

Available actions:
- Check table availability
- Create reservation
- Modify reservation
- Cancel reservation
- Answer menu questions`,

  defaultIvrMenu: [
    { digit: "1", action: "continue", label: "Make Reservation" },
    { digit: "2", action: "continue", label: "Modify Reservation" },
    { digit: "3", action: "continue", label: "Menu Information" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Speak to Staff" }
  ],

  defaultBusinessHours: {
    timezone: "UTC",
    monday: { open: "11:00", close: "22:00" },
    tuesday: { open: "11:00", close: "22:00" },
    wednesday: { open: "11:00", close: "22:00" },
    thursday: { open: "11:00", close: "22:00" },
    friday: { open: "11:00", close: "23:00" },
    saturday: { open: "10:00", close: "23:00" },
    sunday: { open: "10:00", close: "21:00" }
  },

  defaultKnowledgeBase: [
    {
      category: "faq",
      question: "What are your hours?",
      answer: "We're open Monday-Thursday 11am-10pm, Friday-Saturday 11am-11pm, Sunday 10am-9pm. Kitchen closes 30 minutes before closing.",
      keywords: "hours,open,close,time"
    },
    {
      category: "faq",
      question: "Do you have vegetarian options?",
      answer: "Yes! We have a full vegetarian menu with 15+ dishes. We also accommodate vegan and gluten-free diets. Please inform your server of any allergies.",
      keywords: "vegetarian,vegan,menu,dietary,gluten"
    },
    {
      category: "faq",
      question: "Do you take reservations?",
      answer: "Yes, we accept reservations for parties of 2 or more. Walk-ins welcome based on availability. Large groups (8+) require 48-hour notice.",
      keywords: "reservation,booking,table,party"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [RESTAURANT_NAME]. This is [AGENT_NAME]. How may I help you today?",
      keywords: "greeting,opening,hello"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-JennyNeural",
    language: "en"
  }
};
