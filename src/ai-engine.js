const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Stato delle conversazioni attive (in memoria, per call SID)
const conversations = new Map();

const DEFAULT_PROMPT = `Sei l'assistente telefonico di un ristorante. Il tuo compito e' prendere ordini dai clienti al telefono.`;

/**
 * Costruisce il system prompt completo per un tenant
 */
function buildSystemPrompt(tenant) {
  let prompt = '';

  if (tenant && tenant.ai_prompt) {
    prompt = tenant.ai_prompt;
  } else if (tenant) {
    prompt = `Sei l'assistente telefonico di "${tenant.name}". Il tuo compito e' prendere ordini dai clienti al telefono.`;
  } else {
    prompt = DEFAULT_PROMPT;
  }

  // Aggiungi menu se presente
  if (tenant && tenant.menu && Array.isArray(tenant.menu) && tenant.menu.length > 0) {
    prompt += '\n\nMENU DISPONIBILE:\n';
    for (const item of tenant.menu) {
      const price = item.price > 0 ? ` - €${Number(item.price).toFixed(2)}` : '';
      prompt += `- ${item.name}${price}\n`;
    }
    prompt += '\nUsa i prezzi del menu quando disponibili.';
  }

  prompt += `

REGOLE:
1. Saluta il cliente in modo cordiale e chiedi cosa desidera ordinare
2. Conferma ogni articolo aggiunto all'ordine
3. Chiedi se vogliono aggiungere qualcosa
4. Chiedi il nome del cliente per l'ordine
5. Riepilogo finale con tutti gli articoli e chiedi conferma
6. Rispondi SEMPRE in italiano
7. Sii conciso - le risposte verranno lette al telefono, quindi frasi brevi

Quando il cliente conferma l'ordine, rispondi con un JSON alla fine del messaggio nel formato:
###ORDER_COMPLETE###
{
  "customer_name": "nome cliente",
  "items": [{"name": "nome articolo", "quantity": 1, "price": 0}],
  "notes": "eventuali note"
}
###END_ORDER###

NON inventare prezzi se non li conosci e non sono nel menu - metti 0 e il ristorante li aggiornera.
Se il cliente vuole annullare, rispondi con:
###ORDER_CANCELLED###`;

  return prompt;
}

/**
 * Inizializza una nuova conversazione per una chiamata
 */
function initConversation(callSid, tenant) {
  const systemPrompt = buildSystemPrompt(tenant);
  conversations.set(callSid, {
    messages: [{ role: 'system', content: systemPrompt }],
    tenantId: tenant ? tenant.id : null,
    orderComplete: false,
    orderData: null
  });
}

/**
 * Processa il messaggio del cliente e genera una risposta AI
 */
async function processMessage(callSid, userMessage, tenant) {
  let conversation = conversations.get(callSid);

  if (!conversation) {
    initConversation(callSid, tenant);
    conversation = conversations.get(callSid);
  }

  // Aggiungi il messaggio dell'utente
  conversation.messages.push({ role: 'user', content: userMessage });

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: conversation.messages,
      temperature: 0.7,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0]?.message?.content || 'Mi scusi, puo ripetere?';

    // Aggiungi la risposta alla conversazione
    conversation.messages.push({ role: 'assistant', content: aiResponse });

    // Controlla se l'ordine e completo
    const orderMatch = aiResponse.match(/###ORDER_COMPLETE###\s*([\s\S]*?)\s*###END_ORDER###/);
    if (orderMatch) {
      try {
        conversation.orderData = JSON.parse(orderMatch[1]);
        conversation.orderComplete = true;
      } catch (e) {
        console.error('Errore parsing ordine JSON:', e);
      }
    }

    if (aiResponse.includes('###ORDER_CANCELLED###')) {
      conversation.orderComplete = true;
      conversation.orderData = null;
    }

    // Rimuovi i marker JSON dalla risposta vocale
    const cleanResponse = aiResponse
      .replace(/###ORDER_COMPLETE###[\s\S]*###END_ORDER###/, '')
      .replace(/###ORDER_CANCELLED###/, '')
      .trim();

    // Conta tokens per usage tracking
    const tokensUsed = completion.usage?.total_tokens || 0;

    return {
      text: cleanResponse,
      orderComplete: conversation.orderComplete,
      orderData: conversation.orderData,
      tokensUsed
    };
  } catch (error) {
    console.error('Errore Groq API:', error);
    return {
      text: 'Mi scusi, ho avuto un problema tecnico. Puo ripetere il suo ordine?',
      orderComplete: false,
      orderData: null,
      tokensUsed: 0
    };
  }
}

/**
 * Genera il saluto iniziale
 */
async function getGreeting(callSid, tenant) {
  initConversation(callSid, tenant);
  return processMessage(callSid, 'Ciao, vorrei fare un ordine.', tenant);
}

/**
 * Ottieni il transcript completo della conversazione
 */
function getTranscript(callSid) {
  const conversation = conversations.get(callSid);
  if (!conversation) return [];

  return conversation.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));
}

/**
 * Ottieni il tenantId della conversazione
 */
function getConversationTenantId(callSid) {
  const conversation = conversations.get(callSid);
  return conversation ? conversation.tenantId : null;
}

/**
 * Pulisci la conversazione dalla memoria
 */
function cleanupConversation(callSid) {
  conversations.delete(callSid);
}

module.exports = {
  initConversation,
  processMessage,
  getGreeting,
  getTranscript,
  getConversationTenantId,
  cleanupConversation
};
