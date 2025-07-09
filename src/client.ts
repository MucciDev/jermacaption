import consola from "consola";
import {
  AutocompleteInteraction,
  Client,
  CommandInteraction,
  MessageContextMenuInteraction,
} from "discord.js";
import { getBannedUsers, getGIFNames, getRandomFile } from "./files";
import Constants from "./constants";
import { generateImage } from "./captions";
import { generateGIF } from "./ffmpeg";

const currentGIFs = getGIFNames();
let bannedUsers: string[] = [];

type QueueItem = {
  interaction: CommandInteraction | MessageContextMenuInteraction;
  text: string;
  gif: string;
  userId: string;
  timestamp: number;
};

// Config (do touch)
const QUEUE_CONFIG = {
  MAX_QUEUE_SIZE: 100,
  MAX_USER_REQUESTS_PER_MINUTE: 3,
  MAX_PROCESSING_TIME_MS: 30000, // 30 seconds
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
  MAX_CONCURRENT_PROCESSING: 5,
};

const gifQueue: QueueItem[] = [];
let processingCount = 0;
const userRequestTimes = new Map<string, number[]>();

// Cleanup old stuff
setInterval(() => {
  const oneMinuteAgo = Date.now() - 60000;
  for (const [userId, times] of userRequestTimes.entries()) {
    const validTimes = times.filter(time => time > oneMinuteAgo);
    if (validTimes.length === 0) {
      userRequestTimes.delete(userId);
    } else {
      userRequestTimes.set(userId, validTimes);
    }
  }
}, QUEUE_CONFIG.CLEANUP_INTERVAL_MS);

// Rate limiting functions
const isRateLimited = (userId: string): boolean => {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  
  const userTimes = userRequestTimes.get(userId) || [];
  const recentRequests = userTimes.filter(time => time > oneMinuteAgo);
  
  return recentRequests.length >= QUEUE_CONFIG.MAX_USER_REQUESTS_PER_MINUTE;
};

const recordRequest = (userId: string): void => {
  const now = Date.now();
  const userTimes = userRequestTimes.get(userId) || [];
  userTimes.push(now);
  userRequestTimes.set(userId, userTimes);
};

const getQueuePosition = (userId: string): number => {
  return gifQueue.findIndex(item => item.userId === userId) + 1;
};

const getUserQueueCount = (userId: string): number => {
  return gifQueue.filter(item => item.userId === userId).length;
};

const isQueueFull = (): boolean => {
  return gifQueue.length >= QUEUE_CONFIG.MAX_QUEUE_SIZE;
};

const canProcessMore = (): boolean => {
  return processingCount < QUEUE_CONFIG.MAX_CONCURRENT_PROCESSING;
};

// Manager
const addToQueue = (item: QueueItem): boolean => {
  // Check if full
  if (isQueueFull()) {
    return false;
  }
  
  // Anti spam
  if (getUserQueueCount(item.userId) >= 2) {
    return false;
  }
  
  gifQueue.push(item);
  consola.info(`Added to queue: ${item.userId}, Queue size: ${gifQueue.length}`);
  return true;
};

const processNextInQueue = async (): Promise<void> => {
  if (gifQueue.length === 0 || !canProcessMore()) {
    return;
  }
  
  const item = gifQueue.shift();
  if (!item) return;
  
  processingCount++;
  consola.info(`Processing: ${item.userId}, Concurrent: ${processingCount}`);
  
  try {
    await processGifWithTimeout(item);
  } catch (error) {
    consola.error(`Error processing gif for ${item.userId}:`, error);
    try {
      await item.interaction.editReply({ 
        content: ":sweat: Sorry! Something went wrong... Try again later!" 
      });
    } catch (replyError) {
      consola.error("Failed to send error message:", replyError);
    }
  } finally {
    processingCount--;
    consola.info(`Finished processing: ${item.userId}, Concurrent: ${processingCount}`);
    
    // Next in line
    setTimeout(() => processNextInQueue(), 100);
  }
};

const processGifWithTimeout = async (item: QueueItem): Promise<void> => {
  return new Promise(async (resolve, reject) => {
    // Timeout
    const timeoutId = setTimeout(() => {
      reject(new Error(`Processing timeout for user ${item.userId}`));
    }, QUEUE_CONFIG.MAX_PROCESSING_TIME_MS);
    
    try {
      await processGif(item.interaction, item.text, item.gif);
      clearTimeout(timeoutId);
      resolve();
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
};

export const launchBot = () => {
  try {
    consola.info("Logging in...");

    const client = new Client({
      intents: ["GUILD_MESSAGES", "MESSAGE_CONTENT"],
    });

    client.on("interactionCreate", async (interaction) => {
      if (bannedUsers.includes(interaction.user.id)) {
        if (interaction.isAutocomplete()) return interaction.respond([]);
        if (
          interaction.isMessageContextMenu() ||
          interaction.isApplicationCommand()
        ) {
          return interaction.reply({
            content: Constants.BANNED_USER_MESSAGE,
            ephemeral: true,
          });
        }
      }

      if (interaction.isAutocomplete()) {
        handleAutocomplete(interaction);
        return;
      }

      // Rate limiting check
      if (isRateLimited(interaction.user.id)) {
        const errorMessage = ":warning: You're sending requests too quickly! Please wait a moment before trying again.";
        if (interaction.isMessageContextMenu() || interaction.isApplicationCommand()) {
          return interaction.reply({
            content: errorMessage,
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.isMessageContextMenu()) {
        if (interaction.targetMessage.content === "")
          return interaction.reply({
            content: ":x: The message must have text.",
            ephemeral: true,
          });
        
        await interaction.deferReply();
        handleNewGIF(interaction, interaction.targetMessage.content);
      }

      if (interaction.isCommand()) {
        await interaction.deferReply();
        handleNewGIF(
          interaction,
          sanitizeInput(interaction.options.getString("text") as string),
          sanitizeInput(interaction.options.getString("gif") as string)
        );
      }
    });

    client.once("ready", () => {
      consola.success("The bot is now working!");

      bannedUsers = getBannedUsers();
      setInterval(() => {
        bannedUsers = getBannedUsers();
      }, 1000 * 60 * 5);
    });

    client.login(process.env.DISCORD_APPLICATION_BOT_TOKEN);
  } catch (e) {
    consola.error(e);
  }
};

const sanitizeInput = (input: string | undefined): string => {
  if (!input) return "";
  return input.replace(/[^a-zA-Z0-9_\- ]/g, ""); // Char check
};

const returnGIFQuery = (searchQuery: string) => {
  return currentGIFs
    .filter((result) =>
      result.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .slice(0, 25);
};

const handleAutocomplete = async (interaction: AutocompleteInteraction) => {
  const searchPhrase = sanitizeInput(interaction.options.get("gif")?.value as string);
  if (searchPhrase === "")
    return interaction.respond(
      currentGIFs
        .map((result) => ({ name: result, value: result }))
        .slice(0, 25)
    );

  const matchingResults = returnGIFQuery(searchPhrase);

  return interaction.respond(
    matchingResults.map((result) => ({ name: result, value: result }))
  );
};

async function handleNewGIF(
  interaction: CommandInteraction | MessageContextMenuInteraction,
  text: string,
  gif?: string
): Promise<void> {
  // Rate limiting help
  recordRequest(interaction.user.id);
  
  if (gif && returnGIFQuery(gif).length === 1) {
    await handleNewGIFWithGif(interaction, text, returnGIFQuery(gif)[0]);
  } else {
    await handleNewGIFWithRandomGif(interaction, text);
  }
}

async function handleNewGIFWithGif(
  interaction: CommandInteraction | MessageContextMenuInteraction,
  text: string,
  gif: string
): Promise<void> {
  const queueItem: QueueItem = {
    interaction,
    text,
    gif,
    userId: interaction.user.id,
    timestamp: Date.now(),
  };

  // Check process
  if (canProcessMore() && gifQueue.length === 0) {
    processingCount++;
    consola.info(`Processing immediately: ${interaction.user.id}`);
    try {
      await processGifWithTimeout(queueItem);
    } catch (error) {
      consola.error(`Error processing gif for ${interaction.user.id}:`, error);
      try {
        await interaction.editReply({ 
          content: ":sweat: Sorry! Something went wrong... Try again later!" 
        });
      } catch (replyError) {
        consola.error("Failed to send error message:", replyError);
      }
    } finally {
      processingCount--;
      processNextInQueue();
    }
  } else {
    // Add to queue
    const added = addToQueue(queueItem);
    if (!added) {
      const reason = isQueueFull() 
        ? "The queue is currently full. Please try again later."
        : "You have too many requests in the queue. Please wait for them to complete.";
      
      await interaction.editReply({
        content: `:warning: ${reason}`
      });
      return;
    }
    
    const position = getQueuePosition(interaction.user.id);
    await interaction.editReply({
      content: `:hourglass: Your request is in the queue! Position: ${position}/${gifQueue.length + processingCount}`
    });
    
    // Start processing queque if not already
    processNextInQueue();
  }
}

async function handleNewGIFWithRandomGif(
  interaction: CommandInteraction | MessageContextMenuInteraction,
  text: string
): Promise<void> {
  const randomGif = getRandomFile(currentGIFs);
  await handleNewGIFWithGif(interaction, text, randomGif);
}

const processGif = async (
  interaction: CommandInteraction | MessageContextMenuInteraction,
  text: string,
  gif: string
) => {
  consola.log(`${interaction.user.id}: ${text}`);
  try {
    await generateImage(text, `${interaction.user.id}-${interaction.id}`);
    const attachment = await generateGIF(gif, `${interaction.user.id}-${interaction.id}`);
    await interaction.editReply({ files: [{ attachment, name: 'jerma.gif' }] });
  } catch (e) {
    consola.error(e);
    throw e; // Re-throw to be handled by the timeout wrapper
  }
};
