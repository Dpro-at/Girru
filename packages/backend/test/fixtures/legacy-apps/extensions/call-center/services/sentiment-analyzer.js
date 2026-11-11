/**
 * Sentiment Analyzer
 * Keyword-based sentiment analysis for call quality assessment
 * Fast, no AI required
 */

/**
 * Sentiment keyword dictionary
 * Organized by emotion type
 */
const SENTIMENT_KEYWORDS = {
  // Positive indicators
  positive: [
    'thank', 'thanks', 'appreciate', 'great', 'perfect', 'excellent',
    'wonderful', 'amazing', 'fantastic', 'helpful', 'solved', 'fixed',
    'happy', 'satisfied', 'pleased', 'love', 'best', 'awesome'
  ],

  // Negative indicators
  negative: [
    'terrible', 'frustrated', 'angry', 'mad', 'upset', 'disappointed',
    'useless', 'worst', 'horrible', 'awful', 'hate', 'never',
    'bad', 'poor', 'unacceptable', 'disgust', 'trash', 'garbage'
  ],

  // Specific emotions
  frustrated: [
    'frustrated', 'frustrating', 'annoying', 'annoyed', 'irritating',
    'irritated', 'stuck', 'waiting', 'hold', 'transfer'
  ],

  satisfied: [
    'satisfied', 'happy', 'pleased', 'resolved', 'fixed', 'solved',
    'working', 'done', 'complete', 'success'
  ],

  confused: [
    'confused', 'confusing', 'unclear', 'understand', 'what', 'how',
    'why', 'explain', 'repeat', 'mean'
  ],

  urgent: [
    'urgent', 'emergency', 'asap', 'immediately', 'now', 'hurry',
    'quick', 'fast', 'critical', 'important'
  ]
};

/**
 * Analyze sentiment from conversation messages
 * @param {Array<string>|string} messages - Array of messages or single text
 * @param {Object} options - Analysis options
 * @returns {Object} Sentiment analysis result
 */
export function analyzeSentiment(messages, options = {}) {
  try {
    // Normalize input to array
    const messageArray = Array.isArray(messages) ? messages : [messages];

    // Combine all messages into single text
    const text = messageArray.join(' ').toLowerCase();

    // Count keyword occurrences
    let positiveCount = 0;
    let negativeCount = 0;
    const detectedEmotions = [];

    // Count positive keywords
    SENTIMENT_KEYWORDS.positive.forEach(word => {
      const regex = new RegExp(`\\b${word}\\w*\\b`, 'g');
      const matches = text.match(regex) || [];
      positiveCount += matches.length;
    });

    // Count negative keywords
    SENTIMENT_KEYWORDS.negative.forEach(word => {
      const regex = new RegExp(`\\b${word}\\w*\\b`, 'g');
      const matches = text.match(regex) || [];
      negativeCount += matches.length;
    });

    // Detect specific emotions
    Object.keys(SENTIMENT_KEYWORDS).forEach(emotion => {
      if (emotion === 'positive' || emotion === 'negative') return;

      const keywords = SENTIMENT_KEYWORDS[emotion];
      let emotionCount = 0;

      keywords.forEach(word => {
        const regex = new RegExp(`\\b${word}\\w*\\b`, 'g');
        const matches = text.match(regex) || [];
        emotionCount += matches.length;
      });

      if (emotionCount > 0) {
        detectedEmotions.push({
          emotion,
          intensity: Math.min(emotionCount / 5, 1.0) // Normalize 0-1
        });
      }
    });

    // Calculate overall sentiment score (-1.0 to 1.0)
    const totalKeywords = positiveCount + negativeCount + 1; // +1 to avoid division by zero
    const score = (positiveCount - negativeCount) / totalKeywords;

    // Determine sentiment label
    let label;
    if (score > 0.2) {
      label = 'positive';
    } else if (score < -0.2) {
      label = 'negative';
    } else {
      label = 'neutral';
    }

    // Calculate confidence (based on total keyword matches)
    const confidence = Math.min((positiveCount + negativeCount) / 10, 1.0);

    // Sort emotions by intensity
    detectedEmotions.sort((a, b) => b.intensity - a.intensity);

    return {
      score,
      label,
      confidence,
      positiveCount,
      negativeCount,
      detectedEmotions: detectedEmotions.map(e => e.emotion),
      emotionDetails: detectedEmotions,
      wordCount: text.split(/\s+/).length
    };
  } catch (error) {
    console.error('[SentimentAnalyzer] Error analyzing sentiment:', error);
    return {
      score: 0,
      label: 'neutral',
      confidence: 0,
      positiveCount: 0,
      negativeCount: 0,
      detectedEmotions: [],
      emotionDetails: [],
      error: error.message
    };
  }
}

/**
 * Analyze sentiment from call messages (database format)
 * @param {Array<Object>} messages - Array of message objects with role and content
 * @returns {Object} Sentiment analysis result
 */
export function analyzeCallSentiment(messages) {
  // Extract only user messages (ignore AI/assistant messages)
  const userMessages = messages
    .filter(msg => msg.role === 'user' || msg.role === 'caller')
    .map(msg => msg.content || msg.message || '');

  return analyzeSentiment(userMessages);
}

/**
 * Get sentiment trend over time
 * @param {Array<Object>} timeSeriesMessages - Messages with timestamps
 * @returns {Array<Object>} Sentiment trend over time
 */
export function analyzeSentimentTrend(timeSeriesMessages) {
  try {
    const windowSize = 5; // Analyze in chunks of 5 messages
    const trend = [];

    for (let i = 0; i < timeSeriesMessages.length; i += windowSize) {
      const chunk = timeSeriesMessages.slice(i, i + windowSize);
      const messages = chunk.map(msg => msg.content || msg.message || '');
      const sentiment = analyzeSentiment(messages);

      trend.push({
        startIndex: i,
        endIndex: Math.min(i + windowSize - 1, timeSeriesMessages.length - 1),
        timestamp: chunk[0]?.timestamp || chunk[0]?.created_at,
        ...sentiment
      });
    }

    return trend;
  } catch (error) {
    console.error('[SentimentAnalyzer] Error analyzing sentiment trend:', error);
    return [];
  }
}

/**
 * Determine if call escalation is needed based on sentiment
 * @param {Object} sentiment - Sentiment analysis result
 * @returns {Object} Escalation recommendation
 */
export function shouldEscalate(sentiment) {
  const reasons = [];
  let shouldEscalate = false;

  // Check negative sentiment
  if (sentiment.score < -0.5 && sentiment.confidence > 0.5) {
    shouldEscalate = true;
    reasons.push('Strong negative sentiment detected');
  }

  // Check frustration
  if (sentiment.detectedEmotions.includes('frustrated')) {
    const frustration = sentiment.emotionDetails.find(e => e.emotion === 'frustrated');
    if (frustration && frustration.intensity > 0.6) {
      shouldEscalate = true;
      reasons.push('High frustration level');
    }
  }

  // Check urgency
  if (sentiment.detectedEmotions.includes('urgent')) {
    reasons.push('Urgent matter detected');
  }

  // Check confusion (may need human intervention)
  if (sentiment.detectedEmotions.includes('confused')) {
    const confusion = sentiment.emotionDetails.find(e => e.emotion === 'confused');
    if (confusion && confusion.intensity > 0.7) {
      shouldEscalate = true;
      reasons.push('Caller seems very confused');
    }
  }

  return {
    shouldEscalate,
    reasons,
    priority: shouldEscalate ? (sentiment.score < -0.7 ? 'high' : 'medium') : 'low'
  };
}

/**
 * Generate sentiment summary for analytics
 * @param {Array<Object>} callSessions - Array of call sessions
 * @returns {Object} Aggregated sentiment statistics
 */
export function generateSentimentSummary(callSessions) {
  try {
    if (!callSessions || callSessions.length === 0) {
      return {
        totalCalls: 0,
        averageScore: 0,
        positivePercentage: 0,
        neutralPercentage: 0,
        negativePercentage: 0,
        topEmotions: []
      };
    }

    let totalScore = 0;
    let positiveCount = 0;
    let neutralCount = 0;
    let negativeCount = 0;
    const emotionCounts = {};

    callSessions.forEach(session => {
      if (session.sentiment_score != null) {
        totalScore += session.sentiment_score;

        if (session.sentiment_label === 'positive') positiveCount++;
        else if (session.sentiment_label === 'neutral') neutralCount++;
        else if (session.sentiment_label === 'negative') negativeCount++;
      }

      // Count emotions
      if (session.detected_emotions) {
        try {
          const emotions = JSON.parse(session.detected_emotions);
          emotions.forEach(emotion => {
            emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
          });
        } catch (e) {
          // Ignore parsing errors
        }
      }
    });

    const totalCalls = callSessions.length;
    const averageScore = totalCalls > 0 ? totalScore / totalCalls : 0;

    // Sort emotions by frequency
    const topEmotions = Object.entries(emotionCounts)
      .map(([emotion, count]) => ({ emotion, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalCalls,
      averageScore: Number(averageScore.toFixed(3)),
      positivePercentage: Number((positiveCount / totalCalls * 100).toFixed(1)),
      neutralPercentage: Number((neutralCount / totalCalls * 100).toFixed(1)),
      negativePercentage: Number((negativeCount / totalCalls * 100).toFixed(1)),
      topEmotions
    };
  } catch (error) {
    console.error('[SentimentAnalyzer] Error generating sentiment summary:', error);
    return {
      totalCalls: 0,
      averageScore: 0,
      positivePercentage: 0,
      neutralPercentage: 0,
      negativePercentage: 0,
      topEmotions: [],
      error: error.message
    };
  }
}

export default {
  analyzeSentiment,
  analyzeCallSentiment,
  analyzeSentimentTrend,
  shouldEscalate,
  generateSentimentSummary,
  SENTIMENT_KEYWORDS
};
