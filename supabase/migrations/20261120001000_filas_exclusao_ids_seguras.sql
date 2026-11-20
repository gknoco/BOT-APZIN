-- Atualização para bancos que já aplicaram a 003 anterior à correção.
-- A 003 também contém as correções para instalações novas.
BEGIN;
-- Ordem igual à do runtime: global antes de qualquer bloqueio de tabela.
SELECT public.royal_blacklist_fila_lock();
LOCK TABLE public.royal_filas IN SHARE ROW EXCLUSIVE MODE;

-- Um DELETE direto pode tomar o snapshot antes de esperar no trigger BEFORE
-- STATEMENT. O lock deve ser obtido em outro comando PL/pgSQL; só então o
-- DELETE usa um snapshot READ COMMITTED novo, inclusive após aguardar INSERT.
CREATE OR REPLACE FUNCTION public.royal_operacional_remover_filas(
  p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_user_id text,p_user_ids text[]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_removidos integer;
BEGIN
  IF nullif(trim(p_guild_id),'') IS NULL THEN RAISE EXCEPTION 'Servidor obrigatório.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  DELETE FROM royal_filas f WHERE f.guild_id=p_guild_id
    AND (p_modo IS NULL OR f.modo=p_modo)
    AND (p_preco IS NULL OR f.preco=p_preco)
    AND (p_gelo IS NULL OR f.gelo=p_gelo)
    AND (p_user_id IS NULL OR f.user_id=p_user_id)
    AND (p_user_ids IS NULL OR f.user_id=ANY(p_user_ids));
  GET DIAGNOSTICS v_removidos=ROW_COUNT;
  RETURN v_removidos;
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_remover_blacklist(p_guild_id text,p_user_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_removidos integer;
BEGIN
  IF nullif(trim(p_guild_id),'') IS NULL OR p_user_id IS NULL THEN RAISE EXCEPTION 'Servidor e usuário obrigatórios.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  DELETE FROM royal_blacklist WHERE guild_id=p_guild_id AND user_id=p_user_id;
  GET DIAGNOSTICS v_removidos=ROW_COUNT;
  RETURN v_removidos;
END $$;

-- IDs suspensos ainda pertencem à reserva, mesmo em outra guild. Cancelamento
-- muda o estado sob o mesmo lock antes de restaurá-los, preservando entrou_em,id.
-- Falhar fechado se já houver uma colisão anterior à instalação, inclusive
-- entre reservas ativas: a reconciliação desses dados não é automática.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM royal_fila_reservas r
    CROSS JOIN LATERAL jsonb_to_recordset(r.filas_originais) AS f(id bigint)
    WHERE r.estado='reservada'
    GROUP BY f.id
    HAVING count(*)>1 OR EXISTS (SELECT 1 FROM royal_filas q WHERE q.id=f.id)
  ) THEN
    RAISE EXCEPTION 'IDs de filas reservadas já colidem; reconcilie antes do corte.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.royal_fila_verificar_id_reservado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM royal_fila_reservas r
    CROSS JOIN LATERAL jsonb_to_recordset(r.filas_originais) AS f(id bigint)
    WHERE r.estado='reservada' AND f.id=NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='PRV03', MESSAGE='ID de fila pertence a uma reserva pendente.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_fila_verificar_id_reservado ON public.royal_filas;
CREATE TRIGGER royal_fila_verificar_id_reservado BEFORE INSERT OR UPDATE OF id ON public.royal_filas
  FOR EACH ROW EXECUTE FUNCTION public.royal_fila_verificar_id_reservado();

REVOKE ALL ON FUNCTION public.royal_operacional_remover_filas(text,text,integer,text,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_remover_filas(text,text,integer,text,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_remover_blacklist(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_remover_blacklist(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_adicionar_blacklist(text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_fila_verificar_id_reservado() FROM PUBLIC,anon,authenticated;

-- REVOKE não remove grants de terceiros nem o poder do proprietário. MEMBER
-- inclui cadeias de membership mesmo com NOINHERIT/SET ROLE (e, de forma
-- conservadora, também memberships com SET desativado no PostgreSQL 16+).
-- Auditar cada papel alcançável, sem modificar grants de outros consumidores.
DO $$
DECLARE v_target record; v_role record; v_priv text; v_func text;
BEGIN
  FOR v_target IN SELECT oid,rolname FROM pg_catalog.pg_roles
                  WHERE rolname IN ('anon','authenticated','service_role') LOOP
    FOR v_role IN SELECT r.oid,r.rolname,r.rolsuper FROM pg_catalog.pg_roles r
                  WHERE pg_catalog.pg_has_role(v_target.oid,r.oid,'MEMBER') LOOP
      IF v_role.rolsuper THEN
        RAISE EXCEPTION 'Papel % pode assumir superusuário %; corte abortado.',v_target.rolname,v_role.rolname;
      END IF;
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF pg_catalog.has_table_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,v_priv) THEN
          RAISE EXCEPTION 'Reserva alterável por % via % (%); corte abortado.',v_target.rolname,v_role.rolname,v_priv;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,v_priv) THEN
          RAISE EXCEPTION 'Grant de coluna % na reserva acessível a % via %; corte abortado.',v_priv,v_target.rolname,v_role.rolname;
        END IF;
      END LOOP;
      FOREACH v_func IN ARRAY ARRAY[
        'public.royal_operacional_reservar_fila(text,text,integer,text,integer)',
        'public.royal_operacional_criar_partida(text,text,text,integer,text,text,jsonb)'
      ] LOOP
        IF pg_catalog.has_function_privilege(v_role.oid,v_func,'EXECUTE') THEN
          RAISE EXCEPTION 'RPC legada % acessível a % via %; corte abortado.',v_func,v_target.rolname,v_role.rolname;
        END IF;
      END LOOP;
      -- service_role continua autorizado às RPCs atuais e à leitura da reserva.
      IF v_target.rolname IN ('anon','authenticated') THEN
        IF pg_catalog.has_table_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,'SELECT') OR
           pg_catalog.has_any_column_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,'SELECT') THEN
          RAISE EXCEPTION 'Reserva legível por % via %; corte abortado.',v_target.rolname,v_role.rolname;
        END IF;
        FOREACH v_func IN ARRAY ARRAY[
          'public.royal_operacional_reservar_fila(text,text,text,text,integer,text,integer)',
          'public.royal_operacional_vincular_canal_reserva(text,text,text)',
          'public.royal_operacional_criar_partida(text,text,text,text,integer,text,text,jsonb)',
          'public.royal_operacional_cancelar_reserva(text,text)',
          'public.royal_operacional_entrar_fila(text,text,integer,text,text)',
          'public.royal_operacional_importar_filas(jsonb)',
          'public.royal_operacional_adicionar_blacklist(text,text,text,text,bigint)',
          'public.royal_operacional_remover_filas(text,text,integer,text,text,text[])',
          'public.royal_operacional_remover_blacklist(text,text)'
        ] LOOP
          IF pg_catalog.has_function_privilege(v_role.oid,v_func,'EXECUTE') THEN
            RAISE EXCEPTION 'RPC de fila % acessível a % via %; corte abortado.',v_func,v_target.rolname,v_role.rolname;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
