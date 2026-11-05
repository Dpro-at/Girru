/**
 * Medical Scheduling Template
 * For appointment booking, prescription refills, medical inquiries
 */

export default {
  name: "Medical Scheduling",
  category: "medical",
  description: "Appointment booking and patient inquiries for medical offices",
  icon: "Stethoscope",

  defaultSystemPrompt: `You are a receptionist for [CLINIC_NAME].

Your role:
- Schedule patient appointments
- Handle prescription refill requests
- Provide office location and hours
- Screen urgent medical needs

Guidelines:
- Be professional, empathetic, and HIPAA-compliant
- NEVER provide medical advice - refer to doctor
- For emergencies: advise calling 911 immediately
- Verify patient information for security
- Confirm appointment details clearly

CRITICAL:
- Do NOT ask for or store sensitive medical information
- For urgent symptoms, advise immediate medical attention
- Always confirm insurance information for appointments

Available actions:
- Check doctor availability
- Schedule appointment
- Reschedule appointment
- Send prescription refill request
- Provide directions`,

  defaultIvrMenu: [
    { digit: "1", action: "continue", label: "Schedule Appointment" },
    { digit: "2", action: "continue", label: "Prescription Refill" },
    { digit: "3", action: "continue", label: "Office Hours & Location" },
    { digit: "9", action: "callback", label: "Request Callback" },
    { digit: "0", action: "human", label: "Speak to Receptionist" }
  ],

  defaultBusinessHours: {
    timezone: "UTC",
    monday: { open: "08:00", close: "17:00" },
    tuesday: { open: "08:00", close: "17:00" },
    wednesday: { open: "08:00", close: "17:00" },
    thursday: { open: "08:00", close: "17:00" },
    friday: { open: "08:00", close: "16:00" },
    saturday: { open: "09:00", close: "12:00" },
    sunday: null
  },

  defaultKnowledgeBase: [
    {
      category: "faq",
      question: "What are your office hours?",
      answer: "Monday-Thursday 8am-5pm, Friday 8am-4pm, Saturday 9am-12pm. We're closed Sundays. For emergencies outside hours, call 911 or visit ER.",
      keywords: "hours,open,close,emergency"
    },
    {
      category: "faq",
      question: "Do you accept my insurance?",
      answer: "We accept most major insurance plans. Please provide your insurance details when booking. Our billing staff will verify coverage before your appointment.",
      keywords: "insurance,accept,coverage,plan"
    },
    {
      category: "faq",
      question: "How do I refill a prescription?",
      answer: "Call us with your name, date of birth, and medication name. We'll contact your pharmacy within 24 hours. For urgent refills, mention that when calling.",
      keywords: "prescription,refill,medication,pharmacy"
    },
    {
      category: "script",
      question: "Call opening",
      answer: "Thank you for calling [CLINIC_NAME]. This is [AGENT_NAME]. How may I help you today?",
      keywords: "greeting,opening,hello"
    },
    {
      category: "policy",
      question: "Emergency disclaimer",
      answer: "For life-threatening emergencies, please hang up and dial 911 immediately. This line is for appointments and non-urgent inquiries only.",
      keywords: "emergency,911,urgent"
    }
  ],

  voiceSettings: {
    provider: "edge-tts",
    voiceId: "en-US-SaraNeural",
    language: "en"
  }
};
