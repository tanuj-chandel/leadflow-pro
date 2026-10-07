import { db } from './database.js';

if (process.env.ALLOW_INSECURE_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Generate a personalized, high-converting WhatsApp reply draft using OpenAI
 */
export async function generateSuggestedReply(lead, incomingMessage) {
  const settings = db.getSettings();
  const apiKey = settings.openaiApiKey;

  const defaultDraft = `Hi ${lead.businessName || 'there'}, thank you for reaching out! We received your message and would love to assist. Are you open for a quick 2-minute call this week? Best regards, Tanuj & Amit | AI AutomationHubs (📞 +91-7704077700)`;

  if (!apiKey || apiKey.trim() === '') {
    return defaultDraft;
  }

  try {
    const prompt = [
      'You are the Executive AI Sales Copilot for AI AutomationHubs India (https://ai-automation-hubs.com).',
      'Co-founders: Tanuj Chandel (+91-7704077700) and Amit Pandey (+91-9990080408).',
      'Core Agency Services:',
      '• Custom AI Copilots & Intelligent 24/7 Assistants',
      '• Business Process & Workflow Automation (eliminating manual repetitive work)',
      '• Automated Lead Systems (instant WhatsApp/Telegram follow-ups & CRM sync)',
      '',
      `Lead Information:`,
      `• Business Name: ${lead.businessName || 'Business'}`,
      `• Location: ${lead.location || 'India'}`,
      `• Segment / Industry: ${lead.segment || 'General'}`,
      `• Website: ${lead.website || 'N/A'}`,
      '',
      `Prospect Incoming Message:`,
      `"${incomingMessage}"`,
      '',
      'Your Goal:',
      'Draft a personalized, high-converting, professional WhatsApp reply acknowledging their message, briefly addressing their question or interest, and proposing a 2-minute discovery call with Tanuj or Amit.',
      'Rules:',
      '1. Keep it concise (2-4 sentences max, optimized for mobile WhatsApp reading).',
      '2. Do NOT invent custom pricing numbers or guarantee impossible delivery timelines.',
      '3. Be courteous, highly professional, and encouraging.',
      '4. Sign off with: "Best regards, Tanuj & Amit | AI AutomationHubs".'
    ].join('\n');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Draft the best WhatsApp response to: "${incomingMessage}"` }
        ],
        temperature: 0.7,
        max_tokens: 250
      })
    });

    if (!res.ok) {
      console.warn('[AI Copilot] OpenAI API call failed with status:', res.status);
      return defaultDraft;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    return reply || defaultDraft;
  } catch (err) {
    console.error('[AI Copilot] Error generating suggested reply:', err.message);
    return defaultDraft;
  }
}

/**
 * Generate a hyper-personalized, high-converting B2B Email Draft tailored to the lead's exact industry, location, and rating.
 */
export async function generatePersonalizedEmailDraft(lead) {
  const settings = db.getSettings();
  const apiKey = settings.openaiApiKey;

  const defaultSubject = `Quick idea for ${lead.businessName || 'your team'} - worth 2 minutes?`;
  const defaultBody = `Hi ${lead.businessName || 'there'} team,\n\nI came across your business in ${lead.location || 'your area'} and wanted to reach out.\n\nWe build custom AI Copilots & 24/7 WhatsApp Assistants that automate customer inquiries, qualification, and appointment bookings.\n\nWould you be open for a quick 2-minute call this week?\n\nWarm regards,\nTanuj Chandel & Amit Pandey\nCo-founders, AI AutomationHubs\nTanuj: +91-7704077700 | Amit: +91-9990080408\nhttps://ai-automation-hubs.com`;

  if (!apiKey || apiKey.trim() === '') {
    return { subject: defaultSubject, body: defaultBody };
  }

  try {
    const combinedText = ((lead.businessName || '') + ' ' + (lead.searchTerm || '') + ' ' + (lead.segment || '')).toLowerCase();
    const isSolar = /solar|energy|clean energy|photovoltaic|electrical/i.test(combinedText);
    const isAgency = /agency|marketing|digital|advertising|media|creative|seo|web design/i.test(combinedText);
    const isDentalClinic = /dental|clinic|implant|cosmetic|orthodontic|health/i.test(combinedText);

    let industryContext = 'High-growth B2B / service business.';
    if (isSolar) {
      industryContext = 'Solar & Renewable Energy contractor in Australia. Key pain point: Installers & owners are on rooftops or job sites all day, missing lucrative $6,000-$25,000 quote inquiries. Hiring a full-time receptionist in Australia costs $70k+/yr. Solution: 24/7 AI WhatsApp assistant that qualifies roof type, quarterly electricity bill, and books quote site visits automatically.';
    } else if (isAgency) {
      industryContext = 'Boutique Digital Marketing / Creative Agency in Europe (Dublin/Amsterdam/UK). Key pain point: Account managers drown in repetitive client onboarding, manual campaign reporting, and lead routing. Solution: Custom AI Copilots that automate client onboarding questionnaires, weekly client reporting, and CRM lead routing.';
    } else if (isDentalClinic) {
      industryContext = 'Private Dental & Cosmetic Clinic. Key pain point: Patients look for treatments after 6 PM when reception is closed, losing high-value implant/invisalign cases. Solution: Instant after-hours AI booking assistant.';
    }

    const systemPrompt = [
      'You are the Elite Outbound Sales Strategist for AI AutomationHubs India (https://ai-automation-hubs.com).',
      'Co-founders: Tanuj Chandel (+91-7704077700) and Amit Pandey (+91-9990080408).',
      'Target Prospect Profile:',
      `- Company: ${lead.businessName || 'Business'}`,
      `- City/Region: ${lead.location || 'N/A'}`,
      `- Rating: ${lead.rating ? lead.rating + ' stars on Google' : 'Reputable local leader'}`,
      `- Website: ${lead.website || 'N/A'}`,
      `- Industry Context: ${industryContext}`,
      '',
      'Your Goal:',
      'Write a concise, natural, non-spammy cold email that sounds like it was personally typed by Tanuj Chandel specifically for this business. Avoid corporate jargon and buzzwords.',
      'Structure:',
      '1. Subject: Short, compelling, natural (under 7 words).',
      '2. Opening: Genuine observation about their rating or location.',
      '3. Exact Pain Point: Focus on their industry reality (e.g. for solar, missed quote calls while on-site; for agencies, manual onboarding & reporting).',
      '4. Specific AI Solution: How 24/7 AI WhatsApp / Copilots capture these opportunities in 48 hours without extra staff.',
      '5. Low-friction CTA: Ask for a casual 2-minute screen-share or quick call.',
      '6. Sign-off: Tanuj Chandel & Amit Pandey, Co-founders, AI AutomationHubs India (Phones + Website).',
      '7. For Solar contractors in Australia, ALWAYS add a P.S.: "P.S. Our official Visiting Card is attached below. You can also test a live 60-second interactive preview of how our AI solar assistant qualifies roof types and power bills here: http://localhost:3000/solar_demo.html"',
      '8. For Agency leads, ALWAYS add a P.S.: "P.S. Our official Visiting Card is attached below with our direct mobile and WhatsApp numbers."',
      '',
      'Output strictly in valid JSON format with keys "subject" and "body".'
    ].join('\n');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Generate the personalized email draft in JSON.' }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!res.ok) {
      console.warn('[AI Copilot] OpenAI email draft generation failed:', res.status);
      return { subject: defaultSubject, body: defaultBody };
    }

    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return {
      subject: parsed.subject || defaultSubject,
      body: parsed.body || defaultBody
    };
  } catch (err) {
    console.error('[AI Copilot] Error in generatePersonalizedEmailDraft:', err.message);
    return { subject: defaultSubject, body: defaultBody };
  }
}
