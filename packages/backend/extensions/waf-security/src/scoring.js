/**
 * WAF Security Scoring Algorithm
 * Calculates comprehensive security scores (0-100) based on scan results
 */

/**
 * Calculate comprehensive security score (0-100)
 *
 * Algorithm:
 * - 60%: Block rate (percentage of payloads successfully blocked)
 * - 10%: WAF detection bonus (presence of WAF adds confidence)
 * - 20%: Severity penalty (critical bypasses heavily penalized)
 * - 10%: Response quality (proper HTTP codes and security headers)
 *
 * @param {object} scanResults - Full scan results from engine
 * @returns {object} Score breakdown
 */
export function calculateSecurityScore(scanResults) {
  const {
    detection = {},
    tests = [],
  } = scanResults;

  // Initialize score components
  let blockRateScore = 0;
  let wafDetectionBonus = 0;
  let severityPenalty = 0;
  let responseQualityScore = 0;

  // 1. Calculate block rate (60 points max)
  const totalTests = tests.length;
  if (totalTests > 0) {
    const blockedCount = tests.filter(t => t.blocked).length;
    const blockRate = blockedCount / totalTests;
    blockRateScore = blockRate * 60;
  }

  // 2. WAF detection bonus (10 points max)
  if (detection.detected) {
    // High confidence WAF detection gets full bonus
    wafDetectionBonus = (detection.confidence / 100) * 10;
  }

  // 3. Severity penalty (up to -20 points)
  const severityWeights = {
    critical: 5,
    high: 3,
    medium: 2,
    low: 1,
  };

  let totalPenalty = 0;
  const bypassedTests = tests.filter(t => !t.blocked);

  for (const test of bypassedTests) {
    const weight = severityWeights[test.severity] || 1;
    totalPenalty += weight;
  }

  // Cap penalty at 20 points
  severityPenalty = Math.min(totalPenalty, 20);

  // 4. Response quality score (10 points max)
  let properResponses = 0;
  const validBlockCodes = [403, 406, 429, 503];

  for (const test of tests) {
    if (test.blocked && validBlockCodes.includes(test.status)) {
      properResponses++;
    }
  }

  if (totalTests > 0) {
    responseQualityScore = (properResponses / totalTests) * 10;
  }

  // Final score calculation
  const rawScore = blockRateScore + wafDetectionBonus + responseQualityScore - severityPenalty;
  const finalScore = Math.max(0, Math.min(100, rawScore));

  // Grade assignment
  const grade = getSecurityGrade(finalScore);

  return {
    score: Math.round(finalScore * 10) / 10, // Round to 1 decimal
    grade,
    breakdown: {
      blockRate: Math.round(blockRateScore * 10) / 10,
      wafDetection: Math.round(wafDetectionBonus * 10) / 10,
      responseQuality: Math.round(responseQualityScore * 10) / 10,
      severityPenalty: Math.round(severityPenalty * 10) / 10,
    },
    metrics: {
      totalTests,
      blockedCount: tests.filter(t => t.blocked).length,
      bypassedCount: bypassedTests.length,
      blockRate: totalTests > 0 ? Math.round((tests.filter(t => t.blocked).length / totalTests) * 100) : 0,
    },
  };
}

/**
 * Get security grade based on score
 * @param {number} score - Security score (0-100)
 * @returns {string} Grade (A+, A, B, C, D, F)
 */
export function getSecurityGrade(score) {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Calculate severity distribution breakdown
 * @param {array} tests - Test results
 * @returns {object} Severity counts
 */
export function calculateSeverityDistribution(tests = []) {
  const distribution = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  const bypassedTests = tests.filter(t => !t.blocked);

  for (const test of bypassedTests) {
    const severity = test.severity || 'medium';
    if (distribution.hasOwnProperty(severity)) {
      distribution[severity]++;
    }
  }

  return distribution;
}

/**
 * Generate actionable security recommendations
 * @param {object} scanResults - Full scan results
 * @param {object} score - Score breakdown
 * @returns {array} Recommendations
 */
export function generateRecommendations(scanResults, score) {
  const recommendations = [];
  const { tests = [], detection = {} } = scanResults;
  const bypassedTests = tests.filter(t => !t.blocked);

  // 1. No WAF detected
  if (!detection.detected) {
    recommendations.push({
      severity: 'critical',
      category: 'Infrastructure',
      title: 'No WAF Detected',
      description: 'No Web Application Firewall was detected. Your application is vulnerable to attacks.',
      action: 'Deploy a WAF solution (Cloudflare, AWS WAF, Imperva, or ModSecurity)',
      priority: 1,
    });
  }

  // 2. Critical bypasses
  const criticalBypasses = bypassedTests.filter(t => t.severity === 'critical');
  if (criticalBypasses.length > 0) {
    const categories = [...new Set(criticalBypasses.map(t => t.category))];
    recommendations.push({
      severity: 'critical',
      category: 'WAF Rules',
      title: `Critical Vulnerabilities Detected (${criticalBypasses.length})`,
      description: `Found ${criticalBypasses.length} critical security bypasses in: ${categories.join(', ')}`,
      action: 'Update WAF rules immediately to block these attack patterns',
      priority: 1,
    });
  }

  // 3. High bypass rate (>30%)
  const bypassRate = tests.length > 0 ? (bypassedTests.length / tests.length) * 100 : 0;
  if (bypassRate > 30) {
    recommendations.push({
      severity: 'high',
      category: 'WAF Configuration',
      title: 'High Bypass Rate Detected',
      description: `${Math.round(bypassRate)}% of attack payloads were not blocked by your WAF`,
      action: 'Review and strengthen WAF rule sets, enable stricter security modes',
      priority: 2,
    });
  }

  // 4. SQL Injection bypasses
  const sqlBypasses = bypassedTests.filter(t => t.category === 'sql_injection');
  if (sqlBypasses.length > 0) {
    recommendations.push({
      severity: 'critical',
      category: 'SQL Injection',
      title: 'SQL Injection Vulnerabilities',
      description: `${sqlBypasses.length} SQL injection payloads bypassed the WAF`,
      action: 'Enable SQL injection protection rules, use parameterized queries in application code',
      priority: 1,
    });
  }

  // 5. XSS bypasses
  const xssBypasses = bypassedTests.filter(t => t.category === 'xss');
  if (xssBypasses.length > 0) {
    recommendations.push({
      severity: 'high',
      category: 'Cross-Site Scripting',
      title: 'XSS Vulnerabilities',
      description: `${xssBypasses.length} XSS payloads bypassed the WAF`,
      action: 'Enable XSS protection rules, implement Content-Security-Policy headers',
      priority: 2,
    });
  }

  // 6. Command injection bypasses
  const cmdBypasses = bypassedTests.filter(t => t.category === 'command_injection');
  if (cmdBypasses.length > 0) {
    recommendations.push({
      severity: 'critical',
      category: 'Command Injection',
      title: 'Command Injection Vulnerabilities',
      description: `${cmdBypasses.length} command injection payloads bypassed the WAF`,
      action: 'Block command injection patterns, sanitize user input, avoid shell execution',
      priority: 1,
    });
  }

  // 7. Low response quality
  if (score.breakdown.responseQuality < 5) {
    recommendations.push({
      severity: 'medium',
      category: 'WAF Configuration',
      title: 'Inconsistent Block Responses',
      description: 'WAF is not returning proper HTTP status codes for blocked requests',
      action: 'Configure WAF to return 403 Forbidden for blocked requests',
      priority: 3,
    });
  }

  // 8. Good security score - positive reinforcement
  if (score.score >= 90) {
    recommendations.push({
      severity: 'info',
      category: 'Security Posture',
      title: 'Excellent Security Score',
      description: 'Your WAF configuration is strong and blocking most attack vectors',
      action: 'Maintain current configuration and monitor for new attack patterns',
      priority: 10,
    });
  }

  // Sort by priority
  return recommendations.sort((a, b) => a.priority - b.priority);
}

/**
 * Calculate security trend (compare current vs baseline)
 * @param {object} currentScore - Current scan score
 * @param {object} baselineScore - Baseline scan score
 * @returns {object} Trend analysis
 */
export function calculateTrend(currentScore, baselineScore) {
  const delta = currentScore.score - baselineScore.score;
  const percentChange = baselineScore.score > 0
    ? Math.round((delta / baselineScore.score) * 100)
    : 0;

  let trend = 'stable';
  let trendIcon = '→';

  if (delta > 5) {
    trend = 'improving';
    trendIcon = '↑';
  } else if (delta < -5) {
    trend = 'declining';
    trendIcon = '↓';
  }

  return {
    trend,
    trendIcon,
    delta: Math.round(delta * 10) / 10,
    percentChange,
    message: getTrendMessage(trend, delta),
  };
}

/**
 * Get human-readable trend message
 * @param {string} trend - Trend direction
 * @param {number} delta - Score change
 * @returns {string} Message
 */
function getTrendMessage(trend, delta) {
  const absDelta = Math.abs(Math.round(delta));

  if (trend === 'improving') {
    return `Security improved by ${absDelta} points`;
  } else if (trend === 'declining') {
    return `Security declined by ${absDelta} points - investigate regressions`;
  } else {
    return 'Security posture remains stable';
  }
}

/**
 * Calculate risk level based on score
 * @param {number} score - Security score (0-100)
 * @returns {string} Risk level (low, medium, high, critical)
 */
export function calculateRiskLevel(score) {
  if (score >= 90) return 'low';
  if (score >= 70) return 'medium';
  if (score >= 50) return 'high';
  return 'critical';
}

/**
 * Generate executive summary
 * @param {object} scanResults - Full scan results
 * @param {object} score - Score breakdown
 * @returns {object} Executive summary
 */
export function generateExecutiveSummary(scanResults, score) {
  const { tests = [], detection = {} } = scanResults;
  const bypassedTests = tests.filter(t => !t.blocked);
  const severityDist = calculateSeverityDistribution(tests);
  const riskLevel = calculateRiskLevel(score.score);

  return {
    score: score.score,
    grade: score.grade,
    riskLevel,
    wafDetected: detection.detected,
    wafType: detection.type || 'None',
    totalTests: tests.length,
    blockedCount: tests.filter(t => t.blocked).length,
    bypassedCount: bypassedTests.length,
    criticalIssues: severityDist.critical,
    highIssues: severityDist.high,
    mediumIssues: severityDist.medium,
    lowIssues: severityDist.low,
    topVulnerabilities: getTopVulnerabilities(bypassedTests, 5),
    keyFindings: generateKeyFindings(scanResults, score),
  };
}

/**
 * Get top N vulnerabilities by severity
 * @param {array} bypassedTests - Tests that were not blocked
 * @param {number} limit - Number of top issues to return
 * @returns {array} Top vulnerabilities
 */
function getTopVulnerabilities(bypassedTests, limit = 10) {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  return bypassedTests
    .sort((a, b) => {
      const severityDiff = severityOrder[a.severity || 'medium'] - severityOrder[b.severity || 'medium'];
      return severityDiff;
    })
    .slice(0, limit)
    .map(test => ({
      category: test.category,
      payload: test.payload,
      severity: test.severity,
      description: test.description,
    }));
}

/**
 * Generate key findings summary
 * @param {object} scanResults - Full scan results
 * @param {object} score - Score breakdown
 * @returns {array} Key findings
 */
function generateKeyFindings(scanResults, score) {
  const findings = [];
  const { tests = [], detection = {} } = scanResults;
  const bypassedTests = tests.filter(t => !t.blocked);

  if (!detection.detected) {
    findings.push('No WAF detected - application is unprotected');
  } else {
    findings.push(`${detection.type} WAF detected with ${detection.confidence}% confidence`);
  }

  const bypassRate = tests.length > 0 ? Math.round((bypassedTests.length / tests.length) * 100) : 0;
  findings.push(`${bypassRate}% of attack payloads bypassed protection`);

  const severityDist = calculateSeverityDistribution(tests);
  if (severityDist.critical > 0) {
    findings.push(`${severityDist.critical} critical vulnerabilities found`);
  }

  if (score.score >= 90) {
    findings.push('Excellent security posture - maintain current configuration');
  } else if (score.score >= 70) {
    findings.push('Good security posture - minor improvements needed');
  } else if (score.score >= 50) {
    findings.push('Moderate security posture - significant improvements required');
  } else {
    findings.push('Poor security posture - immediate action required');
  }

  return findings;
}
