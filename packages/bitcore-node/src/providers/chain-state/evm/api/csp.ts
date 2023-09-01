import { CryptoRpc } from 'crypto-rpc';
import { ObjectID } from 'mongodb';
import { Readable } from 'stream';
import Web3 from 'web3';
import { Transaction } from 'web3-eth';
import { AbiItem } from 'web3-utils';
import * as worker from 'worker_threads';
import Config from '../../../../config';
import logger from '../../../../logger';
import { ITransaction } from '../../../../models/baseTransaction';
import { CacheStorage } from '../../../../models/cache';
import { WalletAddressStorage } from '../../../../models/walletAddress';
import { InternalStateProvider } from '../../../../providers/chain-state/internal/internal';
import { Storage } from '../../../../services/storage';
import { SpentHeightIndicators } from '../../../../types/Coin';
import { IChainConfig, IEVMNetworkConfig } from '../../../../types/Config';
import {
  BroadcastTransactionParams,
  GetBalanceForAddressParams,
  GetBlockParams,
  GetWalletBalanceParams,
  IChainStateService,
  StreamAddressUtxosParams,
  StreamTransactionParams,
  StreamTransactionsParams,
  StreamWalletTransactionsArgs,
  StreamWalletTransactionsParams,
  UpdateWalletParams
} from '../../../../types/namespaces/ChainStateProvider';
import { partition } from '../../../../utils/partition';
import { StatsUtil } from '../../../../utils/stats';
import { ERC20Abi } from '../abi/erc20';
import { MultisendAbi } from '../abi/multisend';
import { EVMBlockStorage } from '../models/block';
import { EVMTransactionStorage } from '../models/transaction';
import { ERC20Transfer, EVMTransactionJSON, IEVMBlock, IEVMTransaction, IEVMTransactionInProcess } from '../types';
import { Erc20RelatedFilterTransform } from './erc20Transform';
import { InternalTxRelatedFilterTransform } from './internalTxTransform';
import { PopulateReceiptTransform } from './populateReceiptTransform';
import { EVMListTransactionsStream } from './transform';
import { MongoBound } from '../../../../models/base';
import { PopulateEffectsTransform } from './populateEffectsTransform';

export class BaseEVMStateProvider extends InternalStateProvider implements IChainStateService {
  config: IChainConfig<IEVMNetworkConfig>;
  static rpcs = {} as { [chain: string]: { [network: string]: { rpc: CryptoRpc; web3: Web3 } } };

  constructor(public chain: string = 'ETH') {
    super(chain);
    this.config = Config.chains[this.chain] as IChainConfig<IEVMNetworkConfig>;
  }

  async getWeb3(network: string): Promise<{ rpc: CryptoRpc; web3: Web3 }> {
    try {
      if (BaseEVMStateProvider.rpcs[this.chain] && BaseEVMStateProvider.rpcs[this.chain][network]) {
        await BaseEVMStateProvider.rpcs[this.chain][network].web3.eth.getBlockNumber();
      }
    } catch (e) {
      delete BaseEVMStateProvider.rpcs[this.chain][network];
    }
    if (!BaseEVMStateProvider.rpcs[this.chain] || !BaseEVMStateProvider.rpcs[this.chain][network]) {
      logger.info(`Making a new connection for ${this.chain}:${network}`);
      const providerIdx = worker.threadId % (this.config[network].providers || []).length;
      const providerConfig = this.config[network].provider || this.config[network].providers![providerIdx];
      const rpcConfig = { ...providerConfig, chain: this.chain, currencyConfig: {} };
      const rpc = new CryptoRpc(rpcConfig, {}).get(this.chain);
      if (BaseEVMStateProvider.rpcs[this.chain]) {
        BaseEVMStateProvider.rpcs[this.chain][network] = { rpc, web3: rpc.web3 };
      } else {
        BaseEVMStateProvider.rpcs[this.chain] = { [network]: { rpc, web3: rpc.web3 } };
      }
    }
    return BaseEVMStateProvider.rpcs[this.chain][network];
  }

  async erc20For(network: string, address: string) {
    const { web3 } = await this.getWeb3(network);
    const contract = new web3.eth.Contract(ERC20Abi as AbiItem[], address);
    return contract;
  }

  async getMultisendContract(network: string, address: string) {
    const { web3 } = await this.getWeb3(network);
    const contract = new web3.eth.Contract(MultisendAbi as AbiItem[], address);
    return contract;
  }

  async getERC20TokenInfo(network: string, tokenAddress: string) {
    const token = await this.erc20For(network, tokenAddress);
    const [name, decimals, symbol] = await Promise.all([
      token.methods.name().call(),
      token.methods.decimals().call(),
      token.methods.symbol().call()
    ]);

    return {
      name,
      decimals,
      symbol
    };
  }

  async getERC20TokenAllowance(network: string, tokenAddress: string, ownerAddress: string, spenderAddress: string) {
    const token = await this.erc20For(network, tokenAddress);
    return await token.methods.allowance(ownerAddress, spenderAddress).call();
  }

  async getFee(params) {
    let { network, target = 4 } = params;
    const chain = this.chain;
    if (network === 'livenet') {
      network = 'mainnet';
    }

    const cacheKey = `getFee-${chain}-${network}-${target}`;
    return CacheStorage.getGlobalOrRefresh(
      cacheKey,
      async () => {
        const txs = await EVMTransactionStorage.collection
          .find({ chain, network, blockHeight: { $gt: 0 } })
          .project({ gasPrice: 1, blockHeight: 1 })
          .sort({ blockHeight: -1 })
          .limit(20 * 200)
          .toArray();

        const blockGasPrices = txs
          .map(tx => Number(tx.gasPrice))
          .filter(gasPrice => gasPrice)
          .sort((a, b) => b - a);

        const whichQuartile = Math.min(target, 4) || 1;
        const quartileMedian = StatsUtil.getNthQuartileMedian(blockGasPrices, whichQuartile);

        const roundedGwei = (quartileMedian / 1e9).toFixed(2);
        const gwei = Number(roundedGwei) || 0;
        const feerate = gwei * 1e9;
        return { feerate, blocks: target };
      },
      CacheStorage.Times.Minute
    );
  }

  async getBalanceForAddress(params: GetBalanceForAddressParams) {
    const { chain, network, address } = params;
    const { web3 } = await this.getWeb3(network);
    const tokenAddress = params.args && params.args.tokenAddress;
    const addressLower = address.toLowerCase();
    const cacheKey = tokenAddress
      ? `getBalanceForAddress-${chain}-${network}-${addressLower}-${tokenAddress.toLowerCase()}`
      : `getBalanceForAddress-${chain}-${network}-${addressLower}`;
    const balances = await CacheStorage.getGlobalOrRefresh(
      cacheKey,
      async () => {
        if (tokenAddress) {
          const token = await this.erc20For(network, tokenAddress);
          const balance = await token.methods.balanceOf(address).call();
          const numberBalance = Number(balance);
          return { confirmed: numberBalance, unconfirmed: 0, balance: numberBalance };
        } else {
          const balance = await web3.eth.getBalance(address);
          const numberBalance = Number(balance);
          return { confirmed: numberBalance, unconfirmed: 0, balance: numberBalance };
        }
      },
      CacheStorage.Times.Minute
    );
    return balances;
  }

  async getLocalTip({ chain, network }) {
    return EVMBlockStorage.getLocalTip({ chain, network });
  }

  async getReceipt(network: string, txid: string) {
    const { web3 } = await this.getWeb3(network);
    return web3.eth.getTransactionReceipt(txid);
  }

  async populateReceipt(tx: MongoBound<IEVMTransaction>) {
    if (!tx.receipt) {
      const receipt = await this.getReceipt(tx.network, tx.txid);
      if (receipt) {
        const fee = receipt.gasUsed * tx.gasPrice;
        await EVMTransactionStorage.collection.updateOne({ _id: tx._id }, { $set: { receipt, fee } });
        tx.receipt = receipt;
        tx.fee = fee;
      }
    }
    return tx;
  }

  populateEffects(tx: MongoBound<IEVMTransaction>) {
    if (!tx.effects || (tx.effects && tx.effects.length == 0)) {
      tx.effects = EVMTransactionStorage.getEffects(tx as IEVMTransactionInProcess);
    }
    return tx;
  }

  async getTransaction(params: StreamTransactionParams) {
    try {
      let { chain, network, txId } = params;
      if (typeof txId !== 'string' || !chain || !network) {
        throw new Error('Missing required param');
      }
      network = network.toLowerCase();
      let query = { chain, network, txid: txId };
      const tip = await this.getLocalTip(params);
      const tipHeight = tip ? tip.height : 0;
      let found = await EVMTransactionStorage.collection.findOne(query);
      if (found) {
        let confirmations = 0;
        if (found.blockHeight && found.blockHeight >= 0) {
          confirmations = tipHeight - found.blockHeight + 1;
        }
        found = await this.populateReceipt(found);
        // Add effects to old db entries
        found = this.populateEffects(found);
        const convertedTx = EVMTransactionStorage._apiTransform(found, { object: true }) as EVMTransactionJSON;
        return { ...convertedTx, confirmations };
      } else {
        return undefined;
      }
    } catch (err) {
      console.error(err);
    }
    return undefined;
  }

  async broadcastTransaction(params: BroadcastTransactionParams) {
    const { network, rawTx } = params;
    const { web3 } = await this.getWeb3(network);
    const rawTxs = typeof rawTx === 'string' ? [rawTx] : rawTx;
    const txids = new Array<string>();
    for (const tx of rawTxs) {
      const txid = await new Promise<string>((resolve, reject) => {
        web3.eth
          .sendSignedTransaction(tx)
          .on('transactionHash', resolve)
          .on('error', reject)
          .catch(e => {
            logger.error('%o', e);
            reject(e);
          });
      });
      txids.push(txid);
    }
    return txids.length === 1 ? txids[0] : txids;
  }

  async streamAddressTransactions(params: StreamAddressUtxosParams) {
    const { req, res, args, chain, network, address } = params;
    const { limit, /*since,*/ tokenAddress } = args;
    if (!args.tokenAddress) {
      const query = {
        $or: [
          { chain, network, from: address },
          { chain, network, to: address },
          { chain, network, 'internal.action.to': address }, // Retained for old db entries
          { chain, network, 'effects.to': address }
        ]
      };

      // NOTE: commented out since and paging for now b/c they were causing extra long query times on insight.
      // The case where an address has >1000 txns is an edge case ATM and can be addressed later
      Storage.apiStreamingFind(EVMTransactionStorage, query, { limit /*since, paging: '_id'*/ }, req!, res!);
    } else {
      try {
        const tokenTransfers = await this.getErc20Transfers(network, address, tokenAddress, args);
        res!.json(tokenTransfers);
      } catch (e) {
        res!.status(500).send(e);
      }
    }
  }

  async streamTransactions(params: StreamTransactionsParams) {
    const { chain, network, req, res, args } = params;
    let { blockHash, blockHeight } = args;
    if (!chain || !network) {
      throw new Error('Missing chain or network');
    }
    let query: any = {
      chain,
      network: network.toLowerCase()
    };
    if (blockHeight !== undefined) {
      query.blockHeight = Number(blockHeight);
    }
    if (blockHash !== undefined) {
      query.blockHash = blockHash;
    }
    const tip = await this.getLocalTip(params);
    const tipHeight = tip ? tip.height : 0;
    return Storage.apiStreamingFind(EVMTransactionStorage, query, args, req, res, t => {
      let confirmations = 0;
      if (t.blockHeight !== undefined && t.blockHeight >= 0) {
        confirmations = tipHeight - t.blockHeight + 1;
      }
      // Add effects to old db entries
      if (!t.effects || (t.effects && t.effects.length == 0)) {
        t.effects = EVMTransactionStorage.getEffects(t as IEVMTransactionInProcess);
      }
      const convertedTx = EVMTransactionStorage._apiTransform(t, { object: true }) as Partial<ITransaction>;
      return JSON.stringify({ ...convertedTx, confirmations });
    });
  }

  async getWalletBalance(params: GetWalletBalanceParams) {
    const { network } = params;
    if (params.wallet._id === undefined) {
      throw new Error('Wallet balance can only be retrieved for wallets with the _id property');
    }
    let addresses = await this.getWalletAddresses(params.wallet._id);
    let addressBalancePromises = addresses.map(({ address }) =>
      this.getBalanceForAddress({ chain: this.chain, network, address, args: params.args })
    );
    let addressBalances = await Promise.all<{ confirmed: number; unconfirmed: number; balance: number }>(
      addressBalancePromises
    );
    let balance = addressBalances.reduce(
      (prev, cur) => ({
        unconfirmed: prev.unconfirmed + Number(cur.unconfirmed),
        confirmed: prev.confirmed + Number(cur.confirmed),
        balance: prev.balance + Number(cur.balance)
      }),
      { unconfirmed: 0, confirmed: 0, balance: 0 }
    );
    return balance;
  }

  getWalletTransactionQuery(params: StreamWalletTransactionsParams) {
    const { chain, network, wallet, args } = params;
    let query = {
      chain,
      network,
      wallets: wallet._id,
      'wallets.0': { $exists: true },
      blockHeight: { $gt: -3 } // Exclude invalid transactions
    } as any;
    if (args) {
      if (args.startBlock || args.endBlock) {
        query.$or = [];
        if (args.includeMempool) {
          query.$or.push({ blockHeight: SpentHeightIndicators.pending });
        }
        let blockRangeQuery = {} as any;
        if (args.startBlock) {
          blockRangeQuery.$gte = Number(args.startBlock);
        }
        if (args.endBlock) {
          blockRangeQuery.$lte = Number(args.endBlock);
        }
        query.$or.push({ blockHeight: blockRangeQuery });
      } else {
        if (args.startDate) {
          const startDate = new Date(args.startDate);
          if (startDate.getTime()) {
            query.blockTimeNormalized = { $gte: new Date(args.startDate) };
          }
        }
        if (args.endDate) {
          const endDate = new Date(args.endDate);
          if (endDate.getTime()) {
            query.blockTimeNormalized = query.blockTimeNormalized || {};
            query.blockTimeNormalized.$lt = new Date(args.endDate);
          }
        }
      }
      if (args.includeInvalidTxs) {
        delete query.blockHeight;
      }
    }
    return query;
  }

  async streamWalletTransactions(params: StreamWalletTransactionsParams) {
    const { network, wallet, res, args } = params;
    const { web3 } = await this.getWeb3(network);
    const query = this.getWalletTransactionQuery(params);

    let transactionStream = new Readable({ objectMode: true });
    const walletAddresses = (await this.getWalletAddresses(wallet._id!)).map(waddres => waddres.address);
    const ethTransactionTransform = new EVMListTransactionsStream(walletAddresses);
    const populateReceipt = new PopulateReceiptTransform();
    const populateEffects = new PopulateEffectsTransform();

    transactionStream = EVMTransactionStorage.collection
      .find(query)
      .sort({ blockTimeNormalized: 1 })
      .addCursorFlag('noCursorTimeout', true);

    if (!args.tokenAddress && wallet._id) {
      const internalTxTransform = new InternalTxRelatedFilterTransform(web3, wallet._id);
      transactionStream = transactionStream.pipe(internalTxTransform);
    }

    if (args.tokenAddress) {
      const tokenAddress = web3.utils.toChecksumAddress(args.tokenAddress);
      const erc20Transform = new Erc20RelatedFilterTransform(tokenAddress);
      transactionStream = transactionStream.pipe(erc20Transform);
    }

    transactionStream
      .pipe(populateReceipt)
      .pipe(populateEffects) // For old db entires
      .pipe(ethTransactionTransform)
      .pipe(res);
  }

  async getErc20Transfers(
    network: string,
    address: string,
    tokenAddress: string,
    args: Partial<StreamWalletTransactionsArgs> = {}
  ): Promise<Array<Partial<Transaction>>> {
    const token = await this.erc20For(network, tokenAddress);
    const [sent, received] = await Promise.all([
      token.getPastEvents('Transfer', {
        filter: { _from: address },
        fromBlock: args.startBlock || 0,
        toBlock: args.endBlock || 'latest'
      }),
      token.getPastEvents('Transfer', {
        filter: { _to: address },
        fromBlock: args.startBlock || 0,
        toBlock: args.endBlock || 'latest'
      })
    ]);
    return this.convertTokenTransfers([...sent, ...received]);
  }

  convertTokenTransfers(tokenTransfers: Array<ERC20Transfer>) {
    return tokenTransfers.map(this.convertTokenTransfer);
  }

  convertTokenTransfer(transfer: ERC20Transfer) {
    const { blockHash, blockNumber, transactionHash, returnValues, transactionIndex } = transfer;
    return {
      blockHash,
      blockNumber,
      transactionHash,
      transactionIndex,
      hash: transactionHash,
      from: returnValues['_from'],
      to: returnValues['_to'],
      value: returnValues['_value']
    } as Partial<Transaction>;
  }

  async getAccountNonce(network: string, address: string) {
    const { web3 } = await this.getWeb3(network);
    const count = await web3.eth.getTransactionCount(address);
    return count;
    /*
     *return EthTransactionStorage.collection.countDocuments({
     *  chain: 'ETH',
     *  network,
     *  from: address,
     *  blockHeight: { $gt: -1 }
     *});
     */
  }

  async getWalletTokenTransactions(
    network: string,
    walletId: ObjectID,
    tokenAddress: string,
    args: StreamWalletTransactionsArgs
  ) {
    const addresses = await this.getWalletAddresses(walletId);
    const allTokenQueries = Array<Promise<Array<Partial<Transaction>>>>();
    for (const walletAddress of addresses) {
      const transfers = this.getErc20Transfers(network, walletAddress.address, tokenAddress, args);
      allTokenQueries.push(transfers);
    }
    let batches = await Promise.all(allTokenQueries);
    let txs = batches.reduce((agg, batch) => agg.concat(batch));
    return txs.sort((tx1, tx2) => tx1.blockNumber! - tx2.blockNumber!);
  }

  async estimateGas(params): Promise<number> {
    return new Promise(async (resolve, reject) => {
      try {
        let { network, value, from, data, /*gasPrice,*/ to } = params;
        const { web3 } = await this.getWeb3(network);
        const dataDecoded = EVMTransactionStorage.abiDecode(data);

        if (dataDecoded && dataDecoded.type === 'INVOICE' && dataDecoded.name === 'pay') {
          value = dataDecoded.params[0].value;
          // gasPrice = dataDecoded.params[1].value;
        } else if (data && data.type === 'MULTISEND') {
          try {
            let method, gasLimit;
            const contract = await this.getMultisendContract(network, to);
            const addresses = web3.eth.abi.decodeParameter('address[]', data.addresses);
            const amounts = web3.eth.abi.decodeParameter('uint256[]', data.amounts);

            switch (data.method) {
              case 'sendErc20':
                method = contract.methods.sendErc20(data.tokenAddress, addresses, amounts);
                gasLimit = method ? await method.estimateGas({ from }) : undefined;
                break;
              case 'sendEth':
                method = contract.methods.sendEth(addresses, amounts);
                gasLimit = method ? await method.estimateGas({ from, value }) : undefined;
                break;
              default:
                break;
            }
            return resolve(Number(gasLimit));
          } catch (err) {
            return reject(err);
          }
        }

        let _value;
        if (data) {
          // Gas estimation might fail with `insufficient funds` if value is higher than balance for a normal send.
          // We want this method to give a blind fee estimation, though, so we should not include the value
          // unless it's needed for estimating smart contract execution.
          _value = web3.utils.toHex(value)
        }

        const opts = {
          method: 'eth_estimateGas',
          params: [
            {
              data,
              to: to && to.toLowerCase(),
              from: from && from.toLowerCase(),
              // gasPrice: web3.utils.toHex(gasPrice), // Setting this lower than the baseFee of the last block will cause an error. Better to just leave it out.
              value: _value
            }
          ],
          jsonrpc: '2.0',
          id: 'bitcore-' + Date.now()
        };

        let provider = web3.currentProvider as any;
        provider.send(opts, (err, data) => {
          if (err) return reject(err);
          if (!data.result) return reject(data.error || data);
          return resolve(Number(data.result));
        });
      } catch (err) {
        return reject(err);
      }
    });
  }

  async getBlocks(params: GetBlockParams) {
    const { query, options } = this.getBlocksQuery(params);
    let cursor = EVMBlockStorage.collection.find(query, options).addCursorFlag('noCursorTimeout', true);
    if (options.sort) {
      cursor = cursor.sort(options.sort);
    }
    let blocks = await cursor.toArray();
    const tip = await this.getLocalTip(params);
    const tipHeight = tip ? tip.height : 0;
    const blockTransform = (b: IEVMBlock) => {
      let confirmations = 0;
      if (b.height && b.height >= 0) {
        confirmations = tipHeight - b.height + 1;
      }
      const convertedBlock = EVMBlockStorage._apiTransform(b, { object: true }) as IEVMBlock;
      return { ...convertedBlock, confirmations };
    };
    return blocks.map(blockTransform);
  }

  async updateWallet(params: UpdateWalletParams) {
    const { chain, network } = params;
    const addressBatches = partition(params.addresses, 500);
    for (let addressBatch of addressBatches) {
      const walletAddressInserts = addressBatch.map(address => {
        return {
          insertOne: {
            document: { chain, network, wallet: params.wallet._id, address, processed: false }
          }
        };
      });

      try {
        await WalletAddressStorage.collection.bulkWrite(walletAddressInserts);
      } catch (err: any) {
        if (err.code !== 11000) {
          throw err;
        }
      }

      const addressBatchLC = addressBatch.map(address => address.toLowerCase());

      await EVMTransactionStorage.collection.updateMany(
        {
          $or: [
            { chain, network, from: { $in: addressBatch } },
            { chain, network, to: { $in: addressBatch } },
            { chain, network, 'internal.action.to': { $in: addressBatchLC } }, // Support old db entries
            { chain, network, 'calls.to': { $in: addressBatchLC } }, // Support old db entries
            { // Support old db entries
              chain,
              network,
              'calls.abiType.type': 'ERC20',
              'calls.abiType.name': { $in: ['transfer', 'transferFrom'] },
              'calls.abiType.params.type': 'address',
              'calls.abiType.params.value': { $in: addressBatchLC }
            },
            { 'effects.to': { $in: addressBatchLC } },
            { 'effects.from': { $in: addressBatchLC } },
          ]
        },
        { $addToSet: { wallets: params.wallet._id } }
      );

      await WalletAddressStorage.collection.updateMany(
        { chain, network, address: { $in: addressBatch }, wallet: params.wallet._id },
        { $set: { processed: true } }
      );
    }
  }

  async getCoinsForTx() {
    return {
      inputs: [],
      outputs: []
    };
  }
}
