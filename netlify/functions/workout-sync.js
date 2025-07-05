import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const WORKOUT_DATABASE_ID = process.env.WORKOUT_DATABASE_ID;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_ACCESS_TOKEN = process.env.STRAVA_ACCESS_TOKEN;

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // Handle webhook verification (required by Strava)
  if (event.httpMethod === 'GET') {
    const { 'hub.challenge': challenge } = event.queryStringParameters || {};
    if (challenge) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 'hub.challenge': challenge }),
      };
    }
  }

  // Handle webhook events
  if (event.httpMethod === 'POST') {
    try {
      const webhookData = JSON.parse(event.body);
      console.log('Received Strava webhook:', webhookData);

      // Only process activity creation events
      if (webhookData.object_type === 'activity' && webhookData.aspect_type === 'create') {
        const activityId = webhookData.object_id;
        
        // Fetch full activity details from Strava
        const stravaActivity = await fetchStravaActivity(activityId);
        
        if (stravaActivity) {
          // Check for duplicates in Notion
          const isDuplicate = await checkForDuplicate(stravaActivity);
          
          if (!isDuplicate) {
            // Create Notion entry
            await createNotionEntry(stravaActivity);
            console.log(`Created Notion entry for activity: ${stravaActivity.name}`);
          } else {
            console.log(`Activity already exists in Notion: ${stravaActivity.name}`);
          }
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true }),
      };

    } catch (error) {
      console.error('Error processing webhook:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message }),
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
};

async function fetchStravaActivity(activityId) {
  try {
    const response = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: {
        'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Strava API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching Strava activity:', error);
    return null;
  }
}

async function checkForDuplicate(stravaActivity) {
  try {
    const activityDate = new Date(stravaActivity.start_date).toISOString().split('T')[0];
    
    const existingActivities = await notion.databases.query({
      database_id: WORKOUT_DATABASE_ID,
      filter: {
        and: [
          {
            property: 'Date',
            date: { equals: activityDate }
          },
          {
            property: 'Strava ID',
            rich_text: { equals: stravaActivity.id.toString() }
          }
        ]
      },
    });

    return existingActivities.results.length > 0;
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return false;
  }
}

async function createNotionEntry(stravaActivity) {
  const workoutCategory = categorizeStravaActivity(stravaActivity.sport_type || stravaActivity.type);
  const startDate = new Date(stravaActivity.start_date).toISOString().split('T')[0];
  
  const notionData = {
    parent: { database_id: WORKOUT_DATABASE_ID },
    properties: {
      'Date': {
        date: { start: startDate }
      },
      'Workout Type': {
        select: { name: workoutCategory }
      },
      'Specific Activity': {
        rich_text: [{ text: { content: stravaActivity.name } }]
      },
      'Duration (Minutes)': {
        number: Math.round(stravaActivity.elapsed_time / 60)
      },
      'Calories': {
        number: stravaActivity.calories || 0
      },
      'Source': {
        select: { name: 'Strava' }
      },
      'Strava ID': {
        rich_text: [{ text: { content: stravaActivity.id.toString() } }]
      },
      'Distance (km)': {
        number: stravaActivity.distance ? Math.round(stravaActivity.distance / 1000 * 100) / 100 : 0
      }
    }
  };

  return await notion.pages.create(notionData);
}

function categorizeStravaActivity(activityType) {
  const type = activityType.toLowerCase();
  
  if (type.includes('yoga')) {
    return 'Yoga';
  }
  
  if (type.includes('weight') || type.includes('strength') || 
      type.includes('crosstraining') || type.includes('workout')) {
    return 'Lifting';
  }
  
  if (type.includes('run') || type.includes('ride') || type.includes('bike') ||
      type.includes('swim') || type.includes('cardio') || type.includes('hiit')) {
    return 'Cardio';
  }
  
  return 'Other';
}