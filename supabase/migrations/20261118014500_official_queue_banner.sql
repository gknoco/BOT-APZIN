INSERT INTO public.discord_configuracoes (guild_id, chave, valor, atualizado_em)
VALUES (
  '1543683482708877312',
  'filas_visual',
  '{"avatar_url":"https://i.imgur.com/HafcvNT.png","banner_url":"https://files.manuscdn.com/user_upload_by_module/session_file/310519664038615996/rnCaXStafKLFFoai.webp"}',
  now()
)
ON CONFLICT (guild_id, chave) DO UPDATE
SET valor = EXCLUDED.valor,
    atualizado_em = EXCLUDED.atualizado_em;
