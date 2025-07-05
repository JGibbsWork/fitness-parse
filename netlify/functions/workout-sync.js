import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// Your Notion database ID (you'll set this as environment variable)
const WORKOUT_DATABASE_ID = process.env.WORKOUT_DATABASE_ID;

export const handler = async (event, context) => {
  // Set CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { workouts } = JSON.parse(event.body);
    
    if (!workouts || !Array.isArray(workouts)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid workout data' }),
      };
    }

    // First, check for duplicates by querying existing workouts for today
    const today = new Date().toISOString().split('T')[0];
    const existingWorkouts = await notion.databases.query({
      database_id: WORKOUT_DATABASE_ID,
      filter: {
        property: 'Date',
        date: {
          equals: today,
        },
      },
    });

    const results = [];
    const skipped = [];

    for (const workout of workouts) {
      const {
        type,
        duration, // in minutes
        calories,
        startDate,
        endDate,
        source = 'Apple Watch'
      } = workout;

      // Check if this exact workout already exists (same type, duration, start time)
      const workoutStartTime = new Date(startDate).toISOString();
      const isDuplicate = existingWorkouts.results.some(existing => {
        const existingType = existing.properties['Specific Activity']?.rich_text?.[0]?.text?.content;
        const existingDuration = existing.properties['Duration (Minutes)']?.number;
        const existingStart = existing.properties['Start Time']?.rich_text?.[0]?.text?.content;
        
        return existingType === type && 
               existingDuration === Math.round(duration) &&
               existingStart === workoutStartTime;
      });

      if (isDuplicate) {
        skipped.push({
          workout: type,
          duration: Math.round(duration),
          reason: 'Already exists'
        });
        continue;
      }

      // Determine workout category for your system
      const workoutCategory = categorizeWorkout(type);

      // Create Notion database entry
      const notionResponse = await notion.pages.create({
        parent: {
          database_id: WORKOUT_DATABASE_ID,
        },
        properties: {
          'Date': {
            date: {
              start: new Date(startDate).toISOString().split('T')[0],
            },
          },
          'Workout Type': {
            select: {
              name: workoutCategory,
            },
          },
          'Specific Activity': {
            rich_text: [
              {
                text: {
                  content: type,
                },
              },
            ],
          },
          'Duration (Minutes)': {
            number: Math.round(duration),
          },
          'Calories': {
            number: calories || 0,
          },
          'Source': {
            select: {
              name: source,
            },
          },
          'Start Time': {
            rich_text: [
              {
                text: {
                  content: workoutStartTime,
                },
              },
            ],
          },
        },
      });

      results.push({
        workout: type,
        duration: Math.round(duration),
        category: workoutCategory,
        notionId: notionResponse.id,
      });
    }

    // Return summary for the shortcut to display
    const workoutSummary = results.map(r => 
      `✅ ${r.workout}: ${r.duration}min → ${r.category}`
    ).join('\n');

    const skippedSummary = skipped.length > 0 ? 
      `\n\nSkipped (duplicates):\n${skipped.map(s => `⏭️ ${s.workout}: ${s.duration}min`).join('\n')}` : '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        summary: `Processed ${workouts.length} workout(s)\nAdded: ${results.length} | Skipped: ${skipped.length}\n\n${workoutSummary}${skippedSummary}`,
        added: results.length,
        skipped: skipped.length,
        workouts: results,
        duplicates: skipped,
      }),
    };

  } catch (error) {
    console.error('Error processing workout:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to process workout data',
        details: error.message 
      }),
    };
  }
};

function categorizeWorkout(workoutType) {
  const type = workoutType.toLowerCase();
  
  // Map Apple Health workout types to your Notion categories
  if (type.includes('yoga')) {
    return 'Yoga';
  }
  
  if (type.includes('functional strength') || type.includes('strength') || 
      type.includes('weight') || type.includes('lifting') || 
      type.includes('bodybuilding') || type.includes('crosstraining')) {
    return 'Lifting';
  }
  
  if (type.includes('cardio') || type.includes('running') || 
      type.includes('cycling') || type.includes('treadmill') ||
      type.includes('bike') || type.includes('stair') || 
      type.includes('hiit') || type.includes('rowing') ||
      type.includes('elliptical') || type.includes('walking')) {
    return 'Cardio';
  }
  
  return 'Other';
}