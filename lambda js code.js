// index.mjs
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import { ComprehendClient, DetectDominantLanguageCommand } from "@aws-sdk/client-comprehend";
import { Buffer } from "buffer";

const region = "ap-southeast-1";
const bedrockClient = new BedrockRuntimeClient({ region });
const pollyClient = new PollyClient({ region });
const translateClient = new TranslateClient({ region });
const comprehendClient = new ComprehendClient({ region });

// Preloaded topics mapping (English slugs)
const topics = {
  "photosynthesis": "photosynthesis",
  "water cycle": "water-cycle", 
  "water-cycle": "water-cycle",
  "newtons law": "newtons-law",
  "newton's law": "newtons-law"
};

// Language code mapping (human label -> ISO)
const langMap = {
  "english": "en",
  "us english": "en", 
  "chinese": "zh",
  "malay": "ms",
  "tamil": "ta"
};

// Your S3 bucket base URL
const S3_BASE = "https://edunova-content-alfaruk.s3.ap-southeast-1.amazonaws.com";

// MOCK AI RESPONSES FOR HACKATHON DEMO
const mockKnowledge = {
  "photosynthesis": "Photosynthesis is the process where plants convert sunlight, water, and carbon dioxide into oxygen and glucose (sugar) using chlorophyll in their chloroplasts. This is essential for plant growth and oxygen production.",
  "water cycle": "The water cycle describes the continuous movement of water on Earth through evaporation, condensation, precipitation, and collection. Water evaporates from surfaces, forms clouds, falls as rain/snow, and returns to oceans and rivers.",
  "newton": "Newton's three laws of motion: 1) Objects at rest stay at rest, 2) Force equals mass times acceleration (F=ma), 3) Every action has an equal and opposite reaction. These laws form the foundation of classical mechanics.",
  "math": "Mathematics is the study of numbers, quantities, shapes, and patterns. It includes algebra, calculus, geometry, statistics, and many other branches that help us understand and describe the world.",
  "algebra": "Algebra is a branch of mathematics that uses symbols and letters to represent numbers and quantities in formulas and equations. It helps solve problems involving unknown variables.",
  "physics": "Physics is the natural science that studies matter, energy, motion, and forces. It explains how the universe behaves through concepts like gravity, electromagnetism, and quantum mechanics.",
  "chemistry": "Chemistry is the study of matter, its properties, composition, and changes. It involves elements, compounds, atoms, molecules, and chemical reactions.",
  "biology": "Biology is the science of life and living organisms, including their structure, function, growth, evolution, and distribution. It covers cells, genetics, ecology, and more.",
  "default": "I'd be happy to explain that concept! This AI tutor demonstrates full integration with AWS services including Lambda, API Gateway, S3, and translation services."
};

// ADDED THE MISSING FUNCTION
async function generateEducationalContent(prompt) {
  // Find the best matching response
  let content = mockKnowledge.default;
  const lowerPrompt = prompt.toLowerCase();
  
  for (const [keyword, response] of Object.entries(mockKnowledge)) {
    if (lowerPrompt.includes(keyword)) {
      content = response;
      break;
    }
  }
  
  return content;
}

export const handler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));
    
    // Parse the request body
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    
    // FIXED: Extract parameters correctly - your frontend sends "message" not "prompt"
    const format = body.format || "chat";
    const prompt = body.message || "";  // Changed from destructuring to direct access
    const language = body.language;

    console.log("Parsed body:", { format, prompt, language });

    if (!prompt || prompt.trim().length === 0) {
      return error("Empty prompt");
    }

    // 1) Detect language of prompt
    let detectedLang = "en";
    try {
      const detectResp = await comprehendClient.send(new DetectDominantLanguageCommand({ 
        Text: prompt.substring(0, 5000) // Comprehend has text length limits
      }));
      detectedLang = detectResp.Languages?.[0]?.LanguageCode || "en";
    } catch (dErr) {
      console.warn("Language detection failed, defaulting to en:", dErr);
      detectedLang = "en";
    }

    // 2) Translate prompt to English for topic matching
    let englishPrompt = prompt;
    if (detectedLang !== "en") {
      try {
        const trans = await translateClient.send(new TranslateTextCommand({
          Text: prompt.substring(0, 5000),
          SourceLanguageCode: detectedLang,
          TargetLanguageCode: "en"
        }));
        englishPrompt = trans.TranslatedText || prompt;
      } catch (tErr) {
        console.warn("Translate failed - using original prompt:", tErr);
      }
    }

    const lowerPrompt = englishPrompt.toLowerCase();

    // 3) Match preloaded topic
    let matchedSlug = null;
    for (const [key, slug] of Object.entries(topics)) {
      if (lowerPrompt.includes(key)) {
        matchedSlug = slug;
        break;
      }
    }

    // 4) Return preloaded content if available and requested
    if (matchedSlug) {
      const extMap = { 
        ebook: "pdf", 
        sketch: "png", 
        video: "mp4", 
        audio: "mp3",
        chat: "" // Add chat to avoid errors
      };
      
      if (extMap[format] && format !== "chat") {
        const ext = extMap[format];
        const filename = encodeURIComponent(`${matchedSlug}.${ext}`);
        const fileUrl = `${S3_BASE}/${format}/${filename}`;

        return success({
          reply: `Here is your ${format} on ${matchedSlug}`,
          fileUrl,
          type: format
        });
      }
    }

    // 5) Handle chat requests - MOCK IMPLEMENTATION for hackathon
    if (format === "chat") {
      // Find the best matching response
      let aiReply = mockKnowledge.default;
      const lowerPrompt = prompt.toLowerCase();
      for (const [keyword, response] of Object.entries(mockKnowledge)) {
        if (lowerPrompt.includes(keyword)) {
          aiReply = response;
          break;
        }
      }

      // Translate response if requested
      const userLangLabel = (language || "").toLowerCase();
      const userLangCode = langMap[userLangLabel] || detectedLang || "en";

      if (userLangCode !== "en") {
        try {
          const tr = await translateClient.send(new TranslateTextCommand({
            Text: aiReply.substring(0, 5000),
            SourceLanguageCode: "en",
            TargetLanguageCode: userLangCode
          }));
          aiReply = tr.TranslatedText || aiReply;
        } catch (tErr) {
          console.warn("Response translation failed:", tErr);
        }
      }

      return success({ 
        reply: aiReply, 
        type: "chat",
        detectedLanguage: detectedLang
      });
    }

    // 6) Handle audio generation
    if (format === "audio") {
      const educationalResponse = await generateEducationalContent(prompt);
      const textToRead = educationalResponse;
      const voice = chooseVoiceByLang(detectedLang);
      const speech = await pollyClient.send(new SynthesizeSpeechCommand({
        OutputFormat: "mp3",
        VoiceId: voice,
        Text: textToRead.substring(0, 3000) // Polly has character limits
      }));

      const audioBuffer = await streamToBuffer(speech.AudioStream);
      const audioBase64 = audioBuffer.toString("base64");

      return success({
        reply: "Here is your audio response",
        audio: `data:audio/mp3;base64,${audioBase64}`,
        type: "audio"
      });
    }

    return error("Invalid format or no content available");

  } catch (err) {
    console.error("Handler error:", err);
    return error("Internal server error: " + err.message);
  }
};

// Helper functions
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function chooseVoiceByLang(langCode) {
  const voiceMap = {
    "zh": "Zhiyu",     // Chinese
    "ms": "Amee",      // Malay (using nearest available)
    "ta": "Aditi",     // Tamil (using nearest available)
    "default": "Joanna" // English default
  };
  return voiceMap[langCode] || voiceMap.default;
}

function success(data) {
  return {
    statusCode: 200,
    body: JSON.stringify(data)
  };
}

function error(msg) {
  return {
    statusCode: 400,
    body: JSON.stringify({ error: msg })
  };
}