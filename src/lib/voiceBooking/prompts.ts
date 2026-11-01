/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Prompts & Response Generators
 * Multilingual conversational responses tailored to BREW's luxury artisanal coffee brand.
 * Supports English, Hindi (Devanagari & Hinglish), and Telugu (Script & Tenglish).
 */

import { SupportedLanguage } from "./types";

export const GREETINGS: Record<SupportedLanguage, string> = {
  en: "Welcome to BREW Coffee Concierge. I can help you book our artisanal mobile coffee bar for your private gathering, corporate celebration, or wedding. How many guests are you expecting?",
  hi: "BREW कॉफ़ी कंसीयर्ज में आपका स्वागत है। मैं आपकी शादी, कॉर्पोरेट या निजी कार्यक्रम के लिए हमारे मोबाइल कॉफ़ी बार की बुकिंग में मदद कर सकता हूँ। आपके कार्यक्रम में लगभग कितने मेहमान शामिल होंगे?",
  te: "BREW కాఫీ కన్సియర్జ్‌కు స్వాగతం. మీ ప్రైవేట్ పార్టీ, కార్పొరేట్ వేడుక లేదా వివాహం కోసం మా మొబైల్ కాఫీ బార్‌ను బుక్ చేసుకోవడంలో నేను మీకు సహాయం చేయగలను. ఎంత మంది అతిథులు వస్తున్నారు?",
};

export const MISSING_FIELD_PROMPTS: Record<
  SupportedLanguage,
  Record<string, string>
> = {
  en: {
    guestCount: "How many guests are you expecting for the event?",
    eventDate: "What date is the event scheduled for (e.g. 2026-12-15)?",
    startTime: "At what time should our mobile coffee van arrive and begin service (e.g. 10:00 AM or 16:00)?",
    durationHours: "How many hours of dedicated coffee service do you require (e.g. 3 or 4 hours)?",
    venueAddress: "Where is the event venue located in Hyderabad (e.g. Hitec City, Gachibowli, Jubilee Hills)?",
  },
  hi: {
    guestCount: "आपके कार्यक्रम में लगभग कितने मेहमान शामिल होंगे?",
    eventDate: "कार्यक्रम किस तारीख को आयोजित होगा (जैसे 2026-12-15)?",
    startTime: "हमारी मोबाइल कॉफ़ी वैन को किस समय सेवा शुरू करनी चाहिए (जैसे सुबह 10:00 बजे या शाम 4:00 बजे)?",
    durationHours: "आपको कितने घंटे की कॉफ़ी सेवा की आवश्यकता होगी (जैसे 3 या 4 घंटे)?",
    venueAddress: "हैदराबाद में कार्यक्रम का स्थान कहाँ है (जैसे Hitec City, Gachibowli, या Jubilee Hills)?",
  },
  te: {
    guestCount: "మీ కార్యక్రమానికి ఎంత మంది అతిథులు వస్తున్నారు?",
    eventDate: "కార్యక్రమం ఏ తేదీన నిర్వహించబడుతుంది (ఉదాహరణకు 2026-12-15)?",
    startTime: "మా మొబైల్ కాఫీ వ్యాన్ ఏ సమయానికి సర్వీస్ ప్రారంభించాలి (ఉదాహరణకు ఉదయం 10:00 లేదా సాయంత్రం 4:00)?",
    durationHours: "మీకు ఎన్ని గంటల కాఫీ సర్వీస్ అవసరం (ఉదాహరణకు 3 లేదా 4 గంటలు)?",
    venueAddress: "హైదరాబాద్‌లో ఈవెంట్ వేదిక ఎక్కడ ఉంది (ఉదాహరణకు హైటెక్ సిటీ, గచ్చిబౌలి, లేదా జూబ్లీ హిల్స్)?",
  },
};

export const CONFIRMATION_AWAITING_STAFF_APPROVAL: Record<SupportedLanguage, string> = {
  en: "Thank you! Your booking request and package selection have been securely recorded. It is now awaiting review and operational scheduling by our staff concierge team. We will contact you shortly with the final confirmation.",
  hi: "धन्यवाद! आपका बुकिंग अनुरोध और पैकेज चयन दर्ज कर लिया गया है। यह वर्तमान में हमारी स्टाफ़ टीम की समीक्षा और शेड्यूलिंग के लिए प्रतीक्षारत है। हमारी टीम जल्द ही आपसे अंतिम पुष्टि के साथ संपर्क करेगी।",
  te: "ధన్యవాదాలు! మీ బుకింగ్ అభ్యర్థన మరియు ప్యాకేజీ ఎంపిక నమోదు చేయబడ్డాయి. ఇది ప్రస్తుతం మా స్టాఫ్ బృందం సమీక్ష మరియు షెడ్యూలింగ్ కోసం వేచి ఉంది. మా బృందం త్వరలోనే తుది నిర్ధారణతో మిమ్మల్ని సంప్రదిస్తుంది.",
};

export const DECLINED_MESSAGES: Record<SupportedLanguage, string> = {
  en: "Understood. We have cancelled this quotation. If your plans change, feel free to contact BREW Coffee Concierge at any time. Have a wonderful day!",
  hi: "समझ गया। हमने इस कोटेशन को रद्द कर दिया है। यदि आपकी योजना बदलती है, तो कृपया बेझिझक BREW कॉफ़ी से दोबारा संपर्क करें। आपका दिन शुभ हो!",
  te: "అర్థమైంది. మేము ఈ కొటేషన్‌ను రద్దు చేసాము. మీ ప్రణాళిక మారితే, ఎప్పుడైనా BREW కాఫీని సంప్రదించవచ్చు. మీకు శుభదినం!",
};

export const HANDOFF_MESSAGES: Record<SupportedLanguage, string> = {
  en: "I am connecting you with our human event concierge specialist right away. Please hold on a moment while I transfer you.",
  hi: "मैं आपको तुरंत हमारे इवेंट कंसीयर्ज विशेषज्ञ से जोड़ रहा हूँ। कृपया एक क्षण प्रतीक्षा करें।",
  te: "నేను మిమ్మల్ని వెంటనే మా మానవ ఈవెంట్ కన్సియర్జ్ నిపుణుడితో కనెక్ట్ చేస్తున్నాను. దయచేసి ఒక క్షణం వేచి ఉండండి.",
};

export const CANCELLED_MESSAGES: Record<SupportedLanguage, string> = {
  en: "Your booking request has been cancelled. Thank you for considering BREW Coffee.",
  hi: "आपका बुकिंग अनुरोध रद्द कर दिया गया है। BREW कॉफ़ी पर विचार करने के लिए धन्यवाद।",
  te: "మీ బుకింగ్ అభ్యర్థన రద్దు చేయబడింది. BREW కాఫీని పరిశీలించినందుకు ధన్యవాదాలు.",
};

/**
 * Returns a tailored response asking for the next missing mandatory field.
 */
export function getPromptForNextMissingField(
  missingField: string,
  language: SupportedLanguage
): string {
  const languagePrompts = MISSING_FIELD_PROMPTS[language] || MISSING_FIELD_PROMPTS.en;
  return languagePrompts[missingField] || `Please provide the ${missingField} for your booking.`;
}
