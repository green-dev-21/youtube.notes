import { YoutubeTranscript } from 'youtube-transcript';

export const prerender = false;

// Helpers
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Token-saving cleaner
function cleanTranscript(text) {
  return text
    // Remove bracketed elements like [Music], [Applause], [Laughter] etc.
    .replace(/\[.*?\]/g, '')
    // Remove repeated filler words to save tokens (removes 20-30% of content)
    .replace(/\b(um|uh|like|you know|so|basically|actually|literally|right|you see|sort of|kind of|i mean)\b/gi, '')
    // Remove extra whitespaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// RAG-based Extractive Sentence Ranker to compress transcripts while maintaining full-video coverage
function compressTranscriptRAG(text, maxWords = 3000) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) {
    return text;
  }

  const sentences = text.split(/(?<=[.!?|।])\s+/);
  if (sentences.length <= 10) {
    return text;
  }

  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'about', 'as', 'into', 'like', 'through',
    'after', 'before', 'during', 'without', 'under', 'above', 'i', 'you', 'he', 'she', 'it',
    'we', 'they', 'them', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that',
    'these', 'those', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'can', 'could', 'may', 'might', 'must', 'ko', 'ka', 'ke', 'ki', 'me', 'se', 'hi',
    'bhi', 'hai', 'hain', 'tha', 'the', 'thi', 'ho', 'har', 'ek', 'aur', 'ya', 'toh'
  ]);

  const tf = {};
  sentences.forEach(sentence => {
    const cleanWords = sentence.toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, '')
      .split(/\s+/);
      
    cleanWords.forEach(word => {
      if (word && word.length > 2 && !stopWords.has(word)) {
        tf[word] = (tf[word] || 0) + 1;
      }
    });
  });

  const scoredSentences = sentences.map((sentence, index) => {
    const cleanWords = sentence.toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, '')
      .split(/\s+/);
      
    let score = 0;
    let validWordCount = 0;
    
    cleanWords.forEach(word => {
      if (word && !stopWords.has(word) && tf[word]) {
        score += tf[word];
        validWordCount++;
      }
    });
    
    const normalizedScore = validWordCount > 0 ? score / Math.sqrt(cleanWords.length) : 0;
    
    return {
      text: sentence,
      index: index,
      score: normalizedScore,
      wordCount: cleanWords.length
    };
  });

  const sorted = [...scoredSentences].sort((a, b) => b.score - a.score);
  const selected = [];
  let currentWordCount = 0;
  
  for (const item of sorted) {
    if (currentWordCount + item.wordCount > maxWords) {
      if (currentWordCount > 1500) break;
    }
    selected.push(item);
    currentWordCount += item.wordCount;
  }

  selected.sort((a, b) => a.index - b.index);
  return selected.map(item => item.text).join(' ');
}

// Markdown extraction fallbacks for missing keys or parsing errors
function extractFlashcardsFromMarkdown(text) {
  const cards = [];
  const lines = text.split('\n');
  let currentQ = '';
  let currentA = '';

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('q:') || trimmed.toLowerCase().startsWith('question:')) {
      if (currentQ && currentA) {
        cards.push({ q: currentQ, a: currentA });
        currentQ = '';
        currentA = '';
      }
      currentQ = trimmed.replace(/^[qQ]:\s*/i, '').replace(/^question:\s*/i, '').trim();
    } else if (trimmed.toLowerCase().startsWith('a:') || trimmed.toLowerCase().startsWith('answer:')) {
      currentA = trimmed.replace(/^[aA]:\s*/i, '').replace(/^answer:\s*/i, '').trim();
    } else if (currentQ && !currentA) {
      currentQ += ' ' + trimmed;
    } else if (currentQ && currentA) {
      currentA += ' ' + trimmed;
    }
  });

  if (currentQ && currentA) {
    cards.push({ q: currentQ, a: currentA });
  }

  if (cards.length === 0) {
    const bullets = lines.filter(l => l.trim().startsWith('-') && l.includes(':'));
    bullets.slice(0, 8).forEach(bullet => {
      const parts = bullet.trim().substring(1).split(':');
      if (parts.length >= 2) {
        cards.push({
          q: `Explain the concept of "${parts[0].trim().replace(/\*\*/g, '')}"`,
          a: parts.slice(1).join(':').trim()
        });
      }
    });
  }

  return cards;
}

function extractMindmapFromMarkdown(text) {
  const nodes = [];
  const lines = text.split('\n');

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
      const leadingSpaces = line.length - line.trimStart().length;
      const level = Math.min(4, Math.max(1, Math.floor(leadingSpaces / 2) + 1));
      const textVal = trimmed.replace(/^[-*\d.]+\s*/, '').trim();
      if (textVal) {
        nodes.push({ level, text: textVal });
      }
    }
  });

  if (nodes.length === 0) {
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        const hashCount = (trimmed.match(/#/g) || []).length;
        const level = Math.min(4, hashCount);
        const textVal = trimmed.replace(/^#+\s*/, '').trim();
        if (textVal) {
          nodes.push({ level, text: textVal });
        }
      }
    });
  }

  return nodes;
}

function parseMarkdownToStructuredNotes(text) {
  const sections = {
    detailed: '',
    summary: '',
    flashcards: [],
    mindmap: [],
    imagePrompt: 'Flat design vector infographic showing central study concepts'
  };

  const lines = text.split('\n');
  let currentSection = 'detailed';
  let detailedLines = [];
  let summaryLines = [];
  let flashcardText = '';
  let mindmapText = '';

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const heading = trimmed.toLowerCase();
      if (heading.includes('summary') || heading.includes('tldr') || heading.includes('tl;dr')) {
        currentSection = 'summary';
      } else if (heading.includes('flashcard') || heading.includes('card')) {
        currentSection = 'flashcards';
      } else if (heading.includes('mindmap') || heading.includes('mind map') || heading.includes('concept map')) {
        currentSection = 'mindmap';
      } else if (heading.includes('image') || heading.includes('prompt')) {
        currentSection = 'imagePrompt';
      } else {
        currentSection = 'detailed';
        detailedLines.push(line);
      }
    } else {
      if (currentSection === 'detailed') {
        detailedLines.push(line);
      } else if (currentSection === 'summary') {
        summaryLines.push(line);
      } else if (currentSection === 'flashcards') {
        flashcardText += line + '\n';
      } else if (currentSection === 'mindmap') {
        mindmapText += line + '\n';
      } else if (currentSection === 'imagePrompt') {
        sections.imagePrompt += ' ' + trimmed;
      }
    }
  });

  sections.detailed = detailedLines.join('\n').trim();
  sections.summary = summaryLines.join('\n').trim();
  sections.flashcards = extractFlashcardsFromMarkdown(flashcardText || sections.detailed);
  sections.mindmap = extractMindmapFromMarkdown(mindmapText || sections.detailed);

  if (!sections.summary) {
    sections.summary = sections.detailed.substring(0, 500) + '...';
  }

  return sections;
}

function sanitizeJsonString(str) {
  let result = '';
  let inString = false;
  let escape = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (inString) {
      if (escape) {
        result += char;
        escape = false;
      } else if (char === '\\') {
        result += char;
        escape = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        const code = char.charCodeAt(0);
        if (code < 32) {
          result += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          result += char;
        }
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
  }
  return result;
}

function normalizeStructuredNotes(parsed) {
  const result = {
    detailed: parsed.detailed || parsed.notes || parsed.detailedNotes || '',
    summary: parsed.summary || parsed.tldr || parsed.quickSummary || '',
    flashcards: [],
    mindmap: [],
    imagePrompt: parsed.imagePrompt || parsed.image_prompt || parsed.prompt || 'Educational infographic showing study concepts'
  };

  const rawCards = parsed.flashcards || parsed.cards || [];
  if (Array.isArray(rawCards)) {
    result.flashcards = rawCards.map(c => {
      if (typeof c === 'object' && c !== null) {
        return {
          q: c.q || c.question || '',
          a: c.a || c.answer || ''
        };
      } else if (typeof c === 'string') {
        const parts = c.split(/\n?[aA]:/i);
        const q = parts[0]?.replace(/^[qQ]:\s*/i, '').trim() || '';
        const a = parts[1]?.trim() || '';
        return { q, a };
      }
      return null;
    }).filter(Boolean);
  }

  const rawMap = parsed.mindmap || parsed.mindMap || parsed.conceptMap || [];
  if (Array.isArray(rawMap)) {
    result.mindmap = rawMap.map(n => {
      if (typeof n === 'object' && n !== null) {
        return {
          level: parseInt(n.level) || 2,
          text: n.text || n.label || n.name || ''
        };
      } else if (typeof n === 'string') {
        return {
          level: 2,
          text: n
        };
      }
      return null;
    }).filter(Boolean);
  }

  if (result.flashcards.length === 0 && result.detailed) {
    result.flashcards = extractFlashcardsFromMarkdown(result.detailed);
  }
  if (result.mindmap.length === 0 && result.detailed) {
    result.mindmap = extractMindmapFromMarkdown(result.detailed);
  }
  if (!result.summary && result.detailed) {
    result.summary = result.detailed.substring(0, 500) + '...';
  }

  return result;
}

const langNames = {
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  auto: 'the same language as the transcript'
};

// Prompt builders structured for dense notes creation
function buildPrompt(transcript, outputLanguage) {
  const targetLang = langNames[outputLanguage] || 'English';

  return `Analyze this YouTube video transcript and generate a complete study bundle in JSON format.

The JSON object MUST strictly contain the following keys and structure:
{
  "detailed": "Comprehensive study notes in Markdown format. Organize into main topics, key concepts, bullet lists, definitions, and takeaways. Include headers like ## 📌 Key Topics, ## 💡 Important Definitions, etc.",
  "summary": "A concise TL;DR summary in Markdown format. List 5-10 key takeaways as quick bullet points, followed by a brief conclusion.",
  "flashcards": [
    {
      "q": "Question covering a key concept or term",
      "a": "Answer explaining the concept clearly"
    }
  ],
  "mindmap": [
    {
      "level": 1,
      "text": "Central Main Topic of the video"
    },
    {
      "level": 2,
      "text": "First Branch/Theme"
    },
    {
      "level": 4,
      "text": "Key detail or child node under the first branch"
    }
  ],
  "imagePrompt": "A highly detailed, professional descriptive prompt for an AI image generator to create a stunning, instructional infographic or conceptual graphic representing the core topic of the video. Write the prompt in English, focusing on flat design vector, clean infographic style, and conceptual clarity. Do not write text labels on the image."
}

CRITICAL:
1. Write the values for "detailed", "summary", "flashcards" (q and a), and "mindmap" (text) entirely in ${targetLang}.
2. Ensure the JSON structure is perfectly valid, clean, and has no markdown syntax outside the string values.
3. Make the detailed notes dense and thorough (roughly 600-1000 words of structured content) and the flashcards must contain 6-10 meaningful Q&A card pairs. Keep responses concise and avoid unnecessary fluff to stay within output limits.

TRANSCRIPT:
${transcript}`;
}

export async function POST(context) {
  try {
    const { url, manualTranscript, noteStyle, language, customApiKey, customGroqApiKey } = await context.request.json();
    
    // 1. Extract Video ID (only if URL is provided)
    let videoId = url ? extractVideoId(url) : null;
    
    const hasManual = manualTranscript && manualTranscript.trim().length > 0;
    
    if (!hasManual && !videoId) {
      return new Response(JSON.stringify({ error: 'Please enter a valid YouTube URL or paste a transcript manually.' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!videoId) {
      videoId = 'manual';
    }

    let rawTranscriptText = '';

    // 2. Fetch Transcript (Check if manual text was pasted first)
    if (manualTranscript && manualTranscript.trim().length > 0) {
      rawTranscriptText = manualTranscript;
    } else {
      try {
        const fetchOptions = language === 'auto' ? {} : { lang: language };
        const transcriptData = await YoutubeTranscript.fetchTranscript(videoId, fetchOptions);
        rawTranscriptText = transcriptData.map(t => t.text).join(' ');
      } catch (scrapeError) {
        const isLangError = scrapeError.message?.includes('No transcripts are available') || 
                            scrapeError.name?.includes('YoutubeTranscriptNotAvailable');
        
        if (isLangError) {
          try {
            console.log(`Requested language '${language}' not available. Fetching default transcript instead.`);
            const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
            rawTranscriptText = transcriptData.map(t => t.text).join(' ');
          } catch (fallbackError) {
            console.error('Fallback transcript fetch failed:', fallbackError);
            return new Response(JSON.stringify({ 
              error: 'SCRAPE_FAILED', 
              message: 'Failed to fetch transcript: ' + fallbackError.message 
            }), { 
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } else {
          console.error('Scraping failed:', scrapeError);
          // Return a distinct rate limit error to trigger frontend manual paste UI
          return new Response(JSON.stringify({ 
            error: 'RATE_LIMIT_BLOCKED', 
            message: 'YouTube is rate-limiting automatic fetching. Please copy and paste the transcript manually.' 
          }), { 
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    if (!rawTranscriptText || rawTranscriptText.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'No transcript text found for this video.' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Clean and Compress Transcript (saves up to 30% tokens)
    const cleanedText = cleanTranscript(rawTranscriptText);
    
    // 4. Compress Transcript using RAG (Extractive Sentence Ranker)
    // Capped at 3000 words for Gemini to save tokens while keeping full-video representation
    const trimmedText = compressTranscriptRAG(cleanedText, 3000);

    // 5. Build prompt
    const prompt = buildPrompt(trimmedText, language);

    // Build optimized shorter prompt for Groq fallback to stay under 12k TPM rate limits
    const groqWordLimit = 2500;
    const words = cleanedText.split(' ');
    const groqTrimmedText = compressTranscriptRAG(cleanedText, 1800);
    const groqPrompt = buildPrompt(groqTrimmedText, language);

    // 6. Get API keys from environment variables
    let geminiKey = customApiKey || process.env.GEMINI_API_KEY;
    let groqKey = customGroqApiKey || process.env.GROQ_API_KEY;

    if (!geminiKey && !groqKey) {
      return new Response(JSON.stringify({ 
        error: 'NO_API_KEY', 
        message: 'No Google Gemini or Groq API key configured. Please add an API key in the settings menu (gear icon in header) or configure your environment variables.' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let notesData = null;
    let usedProvider = 'gemini';

    function parseModelJson(text) {
      let cleaned = text.trim();
      
      // Attempt JSON block extraction
      let jsonStart = cleaned.indexOf('{');
      let jsonEnd = cleaned.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        const jsonCandidate = cleaned.substring(jsonStart, jsonEnd + 1);
        try {
          const parsed = JSON.parse(jsonCandidate);
          return normalizeStructuredNotes(parsed);
        } catch (e) {
          console.warn("Standard JSON.parse failed, attempting control-character sanitization...", e);
          try {
            const sanitized = sanitizeJsonString(jsonCandidate);
            const parsed = JSON.parse(sanitized);
            return normalizeStructuredNotes(parsed);
          } catch (sanitizeError) {
            console.error("Sanitized JSON parsing also failed:", sanitizeError);
          }
        }
      }
      
      return parseMarkdownToStructuredNotes(cleaned);
    }

    // Helper: Try Gemini 2.5 Flash
    async function tryGemini() {
      if (!geminiKey) {
        throw new Error('Gemini API key is not configured.');
      }
      
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                detailed: {
                  type: "string",
                  description: "Comprehensive study notes in Markdown format. Organize into main topics, key concepts, bullet lists, definitions, and takeaways. Include headers like ## 📌 Key Topics, ## 💡 Important Definitions, etc."
                },
                summary: {
                  type: "string",
                  description: "A concise TL;DR summary in Markdown format. List 5-10 key takeaways as quick bullet points, followed by a brief conclusion."
                },
                flashcards: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      q: { type: "string", description: "Question covering a key concept or term" },
                      a: { type: "string", description: "Answer explaining the concept clearly" }
                    },
                    required: ["q", "a"]
                  }
                },
                mindmap: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      level: { type: "integer", description: "1 for central main topic, 2 for main branches, 3/4 for details" },
                      text: { type: "string", description: "Node description or key detail" }
                    },
                    required: ["level", "text"]
                  }
                },
                imagePrompt: {
                  type: "string",
                  description: "A highly detailed, professional descriptive prompt for an AI image generator to create a stunning, instructional infographic or conceptual graphic representing the core topic of the video. Write the prompt in English, focusing on flat design vector, clean infographic style, and conceptual clarity. Do not write text labels on the image."
                }
              },
              required: ["detailed", "summary", "flashcards", "mindmap", "imagePrompt"]
            }
          }
        })
      });

      const geminiData = await geminiResponse.json();

      if (!geminiResponse.ok) {
        throw new Error(geminiData.error?.message || `Gemini API returned status ${geminiResponse.status}`);
      }

      const txt = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!txt) {
        throw new Error('Gemini returned an empty response.');
      }
      return parseModelJson(txt);
    }

    // Helper: Try Groq Llama 3.3 70B
    async function tryGroq(groqPrompt) {
      if (!groqKey) {
        throw new Error('Groq API key is not configured.');
      }

      const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
      
      const groqResponse = await fetch(groqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'user', content: groqPrompt }
          ],
          temperature: 0.3,
          max_tokens: 2048,
          response_format: { type: "json_object" }
        })
      });

      const groqData = await groqResponse.json();

      if (!groqResponse.ok) {
        throw new Error(groqData.error?.message || `Groq API returned status ${groqResponse.status}`);
      }

      const txt = groqData.choices?.[0]?.message?.content || '';
      if (!txt) {
        throw new Error('Groq returned an empty response.');
      }
      return parseModelJson(txt);
    }

    // Execute Waterfall
    if (geminiKey) {
      try {
        console.log('Attempting notes generation with Gemini 2.5 Flash (JSON mode)...');
        notesData = await tryGemini();
        usedProvider = 'gemini';
      } catch (err) {
        console.warn('Gemini generation failed:', err.message);
        
        if (groqKey) {
          console.log('Falling back to Groq Llama 3.3 70B (JSON mode)...');
          try {
            notesData = await tryGroq(groqPrompt);
            usedProvider = 'groq';
          } catch (groqErr) {
            console.error('Groq fallback also failed:', groqErr.message);
            return new Response(JSON.stringify({ 
              error: `Primary Gemini error: ${err.message}. Fallback Groq error: ${groqErr.message}` 
            }), { 
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } else {
          return new Response(JSON.stringify({ error: err.message }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    } else if (groqKey) {
      console.log('No Gemini key configured. Attempting direct notes generation with Groq...');
      try {
        notesData = await tryGroq(groqPrompt);
        usedProvider = 'groq';
      } catch (groqErr) {
        console.error('Direct Groq generation failed:', groqErr.message);
        return new Response(JSON.stringify({ error: groqErr.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ notes: notesData, videoId, provider: usedProvider }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (globalError) {
    return new Response(JSON.stringify({ error: globalError.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
