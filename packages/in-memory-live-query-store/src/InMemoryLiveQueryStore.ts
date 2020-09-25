import {
  DocumentNode,
  ExecutionResult,
  GraphQLSchema,
  isScalarType,
  isNonNullType,
  GraphQLOutputType,
  GraphQLScalarType,
  execute,
  GraphQLFieldResolver,
  GraphQLResolveInfo,
} from "graphql";
import { wrapSchema, TransformObjectFields } from "@graphql-tools/wrap";
import {
  extractLiveQueries,
  LiveQueryStore,
  LiveQueryStoreRegisterParameter,
  UnsubscribeHandler,
} from "@n1ru4l/graphql-live-query";
import { extractLiveQueryRootFieldCoordinates } from "./extractLiveQueryRootFieldCoordinates";

type PromiseOrValue<T> = T | Promise<T>;
type StoreRecord = {
  publishUpdate: (executionResult: ExecutionResult, payload: any) => void;
  identifier: Set<string>;
  executeOperation: () => PromiseOrValue<ExecutionResult>;
};

const isIDScalarType = (type: GraphQLOutputType): type is GraphQLScalarType => {
  if (isNonNullType(type)) {
    return isScalarType(type.ofType);
  }
  return false;
};

const ORIGINAL_CONTEXT_SYMBOL = Symbol("ORIGINAL_CONTEXT");
const ASYNC_ITERABLE_RESOLVER_SYMBOL = Symbol("ASYNC_ITERABLE_RESOLVER");

const isPromise = (input: unknown): input is Promise<unknown> => {
  return (
    typeof input === "object" &&
    "then" in input &&
    typeof input["then"] === "function"
  );
};

// invokes the callback with the resolved or sync input. Handy when you don't know whether the input is a Promise or the actual value you want.
const runWith = (input: unknown, callback: (value: unknown) => void) => {
  if (isPromise(input)) {
    input.then(callback, () => undefined);
  } else {
    callback(input);
  }
};

const addResourceIdentifierCollectorToSchema = (
  schema: GraphQLSchema
): GraphQLSchema =>
  wrapSchema(schema, [
    new TransformObjectFields((typename, fieldName, fieldConfig) => {
      if (fieldConfig?.resolve?.[ASYNC_ITERABLE_RESOLVER_SYMBOL] === true) {
        return fieldConfig;
      }

      let isIDField = fieldName === "id" && isIDScalarType(fieldConfig.type);

      let resolve = fieldConfig.resolve;
      fieldConfig.resolve = (src, args, context, info) => {
        if (!context || !context[ORIGINAL_CONTEXT_SYMBOL]) {
          return resolve(src, args, context, info);
        }

        const gatherId = context.gatherId;
        context = context[ORIGINAL_CONTEXT_SYMBOL];
        const result = resolve(src, args, context, info);
        if (isIDField) {
          if (isPromise(result)) {
            result.then(
              (value) => gatherId(typename, value),
              () => undefined
            );
          } else {
            gatherId(typename, result);
          }
        }
        return result;
      };

      return fieldConfig;
    }),
  ]);

type ResourceGatherFunction = (typename: string, id: string) => void;

export const liveResolver = <
  TSource,
  TContext,
  TArgs = { [argName: string]: any }
>(params: {
  resolver: GraphQLFieldResolver<TSource, TContext, TArgs>;
  subscribe: (
    source: TSource,
    args: TArgs,
    context: TContext,
    info: GraphQLResolveInfo
  ) => AsyncIterator<unknown>;
}) => {
  const asyncIterableResolver = (
    source: TSource,
    args: TArgs,
    context: TContext,
    info: GraphQLResolveInfo
  ) => {
    console.log(info.path, ORIGINAL_CONTEXT_SYMBOL in context);
    if (ORIGINAL_CONTEXT_SYMBOL in context === false) {
      return params.resolver(source, args, context, info);
    }

    console.log("OIOIOI");

    let originalContext = context[ORIGINAL_CONTEXT_SYMBOL];

    const result = params.resolver(source, args, originalContext, info);
    const iterator = params.subscribe(source, args, context, info);

    // @ts-ignore
    context.asyncIteratorResolver.add(info.path, iterator);

    // (async () => {
    //   for await (const firstValue of {
    //     [Symbol.asyncIterator]: () => iterator,
    //   }) {
    //     const result = params.resolver(source, args, originalContext, info);
    //     console.log("EXEC AGAIN", result);
    //   }
    // })();

    return result;
  };
  asyncIterableResolver[ASYNC_ITERABLE_RESOLVER_SYMBOL] = true;
  return asyncIterableResolver;
};

export class InMemoryLiveQueryStore implements LiveQueryStore {
  private _store = new Map<DocumentNode, StoreRecord>();
  // cache that stores all patched schema objects
  private _cache = new Map<GraphQLSchema, GraphQLSchema>();

  register({
    schema: inputSchema,
    operationDocument,
    rootValue,
    contextValue,
    operationVariables,
    operationName,
    publishUpdate,
  }: LiveQueryStoreRegisterParameter): UnsubscribeHandler {
    const [liveQuery] = extractLiveQueries(operationDocument);
    if (!liveQuery) {
      throw new Error("Cannot register live query for the given document.");
    }

    const rootFieldIdentifier = extractLiveQueryRootFieldCoordinates(
      operationDocument,
      operationName
    );

    let schema = this._cache.get(inputSchema);
    if (!schema) {
      schema = addResourceIdentifierCollectorToSchema(inputSchema);
      this._cache.set(inputSchema, schema);
    }

    // keep track that current execution is the latest in order to prevent race-conditions :)
    // let executionCounter = 0;

    const record = {
      publishUpdate,
      identifier: new Set(rootFieldIdentifier),
      executeOperation: () => {
        // executionCounter = executionCounter + 1;
        // const counter = executionCounter;
        // const newIdentifier = new Set(rootFieldIdentifier);
        const gatherId: ResourceGatherFunction = () => undefined;

        // (typename, id) =>
        //   newIdentifier.add(`${typename}:${id}`);

        const asyncIteratorResolver = new Map<
          GraphQLResolveInfo["path"],
          unknown
        >();

        const result = execute({
          schema,
          document: operationDocument,
          operationName,
          rootValue,
          contextValue: {
            [ORIGINAL_CONTEXT_SYMBOL]: contextValue,
            asyncIteratorResolver,
            gatherId,
          },
          variableValues: operationVariables,
        });

        // runWith(result, () => {
        // if (counter === executionCounter) {
        //   record.identifier = newIdentifier;
        // }
        // });

        console.log(asyncIteratorResolver.values());

        return result;
      },
    };

    this._store.set(operationDocument, record);
    // Execute initial query
    runWith(record.executeOperation(), (result) => {
      record.publishUpdate(result, result);
    });

    return () => void this._store.delete(operationDocument);
  }

  async triggerUpdate(identifier: string) {
    // for (const record of this._store.values()) {
    //   if (record.identifier.has(identifier)) {
    //     const result = await record.executeOperation();
    //     record.publishUpdate(result, result);
    //   }
    // }
  }
}
