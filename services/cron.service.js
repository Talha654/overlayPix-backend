import cron from 'node-cron';
import { db } from './firebase.service.js';
import { DateTime } from 'luxon';
import { createAuditLog, AUDIT_TYPES, AUDIT_STATUS } from './audit.service.js';
import logger from './logger.service.js';

/**
 * Update expired events status
 * This function finds all events that have passed their end date/time
 * and updates their status to 'expired'
 */
export const updateExpiredEvents = async () => {
  try {
    console.log('[CRON] Starting expired events check...');
    
    // Get all active events
    const eventsSnapshot = await db.collection('events')
      .where('status', '==', 'active')
      .get();

    if (eventsSnapshot.empty) {
      console.log('[CRON] No active events found');
      return;
    }

    const now = new Date();
    let expiredCount = 0;
    let errorCount = 0;

    // Process each event
    for (const eventDoc of eventsSnapshot.docs) {
      try {
        const event = eventDoc.data();
        const eventId = eventDoc.id;

        // Skip events without eventDate
        if (!event.eventDate) {
          console.log(`[CRON] Event ${eventId} has no eventDate, skipping`);
          continue;
        }

        // Parse event date to ISO string (from Firestore Timestamp, ISO, or _seconds)
        let eventDateISO;
        if (event.eventDate && typeof event.eventDate === 'object' && typeof event.eventDate.toDate === 'function') {
          // Firestore Timestamp object
          eventDateISO = event.eventDate.toDate().toISOString();
        } else if (event.eventDate && !isNaN(Date.parse(event.eventDate))) {
          // ISO string or date string
          eventDateISO = new Date(event.eventDate).toISOString();
        } else if (event.eventDate && typeof event.eventDate._seconds === 'number') {
          // Possibly a plain Timestamp-like object
          eventDateISO = new Date(event.eventDate._seconds * 1000).toISOString();
        } else {
          console.log(`[CRON] Event ${eventId} has invalid eventDate format, skipping`);
          continue;
        }

        // Default to 23:59 if no end time
        let endTimeStr = event.eventEndTime && typeof event.eventEndTime === 'string'
          ? event.eventEndTime
          : '23:59';

        // Parse hours and minutes
        let [hours, minutes] = endTimeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(minutes)) {
          hours = 23;
          minutes = 59;
        }

        // Use luxon to combine date and time in the event's time zone
        const eventTimeZone = event.timeZone || 'local';
        let eventDateObj = DateTime.fromISO(eventDateISO, { zone: eventTimeZone });
        let eventEndDateTime = eventDateObj.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

        // Now, compare current time in the event's time zone
        const nowInEventTZ = DateTime.now().setZone(eventTimeZone);

        // Check if event has expired
        if (nowInEventTZ > eventEndDateTime) {
          // Update event status to expired
          await db.collection('events').doc(eventId).update({
            status: 'expired',
            updatedAt: new Date(),
            expiredAt: new Date()
          });

          expiredCount++;

          // Create audit log for the expiration
          // await createAuditLog({
          //   type: AUDIT_TYPES.EVENT_EXPIRE,
          //   userId: event.userId || null,
          //   userEmail: event.userEmail || 'system@cron',
          //   eventId: eventId,
          //   eventName: event.name || 'Unknown Event',
          //   action: 'Event automatically expired',
          //   details: {
          //     previousStatus: 'active',
          //     newStatus: 'expired',
          //     eventDate: eventDateISO,
          //     eventEndTime: endTimeStr,
          //     timeZone: eventTimeZone,
          //     expiredAt: now.toISOString()
          //   },
          //   status: AUDIT_STATUS.SUCCESS,
          //   metadata: {
          //     source: 'cron_job',
          //     automatic: true
          //   }
          // });

          console.log(`[CRON] Event ${eventId} (${event.name}) marked as expired`);
        }
      } catch (error) {
        errorCount++;
        console.error(`[CRON] Error processing event ${eventDoc.id}:`, error);
        
        // Log error to audit system
        // await createAuditLog({
        //   type: AUDIT_TYPES.ERROR,
        //   userId: null,
        //   userEmail: 'system@cron',
        //   eventId: eventDoc.id,
        //   eventName: 'Unknown Event',
        //   action: 'Cron job event expiration error',
        //   details: {
        //     error: error.message,
        //     stack: error.stack
        //   },
        //   status: AUDIT_STATUS.ERROR,
        //   metadata: {
        //     source: 'cron_job',
        //     operation: 'updateExpiredEvents'
        //   }
        // });
      }
    }

    // Log summary
    const summary = {
      totalEvents: eventsSnapshot.size,
      expiredCount,
      errorCount,
      timestamp: new Date().toISOString()
    };

    console.log(`[CRON] Expired events check completed:`, summary);

    // Log to logger service
    logger.info({
      message: 'Cron job: Expired events check completed',
      ...summary,
      action: 'Cron job completed',
      status: 'success'
    });

    return summary;

  } catch (error) {
    console.error('[CRON] Fatal error in updateExpiredEvents:', error);
    
    // Log fatal error
    // await createAuditLog({
    //   type: AUDIT_TYPES.ERROR,
    //   userId: null,
    //   userEmail: 'system@cron',
    //   eventId: null,
    //   eventName: null,
    //   action: 'Cron job fatal error',
    //   details: {
    //     error: error.message,
    //     stack: error.stack,
    //     operation: 'updateExpiredEvents'
    //   },
    //   status: AUDIT_STATUS.ERROR,
    //   metadata: {
    //     source: 'cron_job',
    //     fatal: true
    //   }
    // });

    logger.error({
      message: 'Cron job: Fatal error in updateExpiredEvents',
      error: error.message,
      stack: error.stack,
      action: 'Cron job failed',
      status: 'error'
    });

    throw error;
  }
};

/**
 * Initialize cron jobs
 * This function sets up all scheduled tasks
 */
export const initializeCronJobs = () => {
  try {
    console.log('[CRON] Initializing cron jobs...');

    // Schedule expired events check to run daily at 11 PM UTC
    // Cron format: '0 23 * * *' = every day at 23:00 (11 PM)
    const expiredEventsJob = cron.schedule('0 23 * * *', async () => {
      try {
        await updateExpiredEvents();
      } catch (error) {
        console.error('[CRON] Error in expired events job:', error);
      }
    }, {
      scheduled: true,
      timezone: "UTC" // Use UTC for consistency
    });

    // Start the job
    expiredEventsJob.start();
    console.log('[CRON] Expired events job scheduled (every 1 hour)');

    // Also run once on startup to catch any events that expired while the server was down
    setTimeout(async () => {
      try {
        console.log('[CRON] Running initial expired events check...');
        await updateExpiredEvents();
      } catch (error) {
        console.error('[CRON] Error in initial expired events check:', error);
      }
    }, 10000); // Wait 10 seconds after startup

    // Log successful initialization
    logger.info({
      message: 'Cron jobs initialized successfully',
      jobs: ['expiredEvents'],
      schedule: '*/5 * * * *',
      timezone: 'UTC',
      action: 'Cron initialization',
      status: 'success'
    });

    return {
      expiredEventsJob,
      status: 'initialized'
    };

  } catch (error) {
    console.error('[CRON] Error initializing cron jobs:', error);
    
    logger.error({
      message: 'Cron jobs initialization failed',
      error: error.message,
      action: 'Cron initialization',
      status: 'error'
    });

    throw error;
  }
};

/**
 * Stop all cron jobs
 */
export const stopCronJobs = () => {
  try {
    console.log('[CRON] Stopping all cron jobs...');
    
    // Get all scheduled tasks and stop them
    const tasks = cron.getTasks();
    Object.keys(tasks).forEach(taskName => {
      tasks[taskName].stop();
      console.log(`[CRON] Stopped job: ${taskName}`);
    });

    logger.info({
      message: 'All cron jobs stopped',
      action: 'Cron shutdown',
      status: 'success'
    });

  } catch (error) {
    console.error('[CRON] Error stopping cron jobs:', error);
    
    logger.error({
      message: 'Error stopping cron jobs',
      error: error.message,
      action: 'Cron shutdown',
      status: 'error'
    });
  }
};

/**
 * Get cron job status
 */
export const getCronStatus = () => {
  try {
    const tasks = cron.getTasks();
    const taskNames = Object.keys(tasks);
    
    return {
      active: taskNames.length > 0,
      jobs: taskNames,
      totalJobs: taskNames.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('[CRON] Error getting cron status:', error);
    return {
      active: false,
      jobs: [],
      totalJobs: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
