/**
 * Get Current Time Tool
 * Returns the current date and time in ISO format.
 */

export default {
  name: "get_current_time",
  description: "Get the current date and time. Optionally specify a timezone.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone name (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo'). Defaults to UTC.",
      },
    },
    required: [],
  },
  handler: async (args = {}) => {
    const { timezone } = args;
    const now = new Date();

    if (timezone) {
      try {
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZoneName: "short",
        });

        const parts = formatter.formatToParts(now);
        const get = (type) => parts.find((p) => p.type === type)?.value;

        return {
          iso: now.toISOString(),
          timezone,
          local: `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`,
          display: formatter.format(now),
          unix: Math.floor(now.getTime() / 1000),
        };
      } catch (error) {
        throw new Error(`Invalid timezone: ${timezone}`);
      }
    }

    return {
      iso: now.toISOString(),
      timezone: "UTC",
      unix: Math.floor(now.getTime() / 1000),
    };
  },
};
