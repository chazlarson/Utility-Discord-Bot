import type { Command } from 'src/types';

import { SlashCommandBuilder } from '@discordjs/builders';
import { checkVoiceErrors } from 'src/discord-utils';
import sessions from './sessions';
import { attachPlayerButtons } from './utils';

const NowPlayingCommand: Command = {
  guildOnly: true,
  slashCommandData: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the player (unpause).'),

  runCommand: async interaction => {
    await interaction.deferReply({ ephemeral: true });

    const session = sessions.get(interaction.guild!.id);
    if (!session) {
      await interaction.editReply({
        components: [],
        embeds: [],
        content: 'Session does not exist.',
      });
      return;
    }
    await checkVoiceErrors(interaction);

    const success = session.resume();
    await interaction.editReply({
      content: success ? 'Resumed.' : 'Could not resume.',
    });
    attachPlayerButtons(interaction, session);
  },
};

export default NowPlayingCommand;
